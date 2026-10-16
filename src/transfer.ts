/**
 * transfer.ts — local-file side of Komari file transfer (host half).
 *
 * Komari splits transfer into a control protocol and a raw byte stream:
 *   upload   POST .../file/upload?operation=init  {path,size}       -> session + chunk_size
 *            POST .../file/upload?operation=chunk&upload_id&chunk_index  <raw bytes>
 *            POST .../file/upload?operation=merge {upload_id}
 *            (cancel is issued as cleanup when any step fails)
 *   download GET  .../file/download?path=<abs>                      -> 200 + file bytes
 *
 * Panel limits this module enforces or relies on: MaxUploadSize 8 GiB, chunk
 * size 1 MiB..128 MiB (25 MiB default), upload sessions expire after 15 minutes,
 * and every chunk's Content-Length must equal its exact expected size — so a
 * chunk is read whole into memory and sent in one request.
 */

import { createWriteStream } from 'node:fs'
import { mkdir, open, stat } from 'node:fs/promises'
import { once } from 'node:events'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { KomariClient, KomariError } from './komari.js'

/** Panel-side hard limit on one uploaded file. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024

/** Result of uploading one local file to one machine. */
export interface UploadOutcome {
  bytes: number
  chunks: number
}

/** Result of downloading one remote file to the local filesystem. */
export interface DownloadOutcome {
  bytes: number
  path: string
  content_type: string | null
  filename: string | null
}

/**
 * Where a download lands when the caller names no destination.
 * @param remotePath - remote path the file is read from.
 * @returns an absolute path under the OS temp directory.
 */
export function defaultDownloadPath(remotePath: string): string {
  const name = basename(remotePath.replace(/\\/g, '/')) || 'komari-download'
  return join(tmpdir(), 'komari-downloads', name)
}

/**
 * Read one chunk of a local file at an exact offset.
 * @param handle - open file handle.
 * @param offset - byte offset to read from.
 * @param length - exact number of bytes to read.
 * @returns the bytes read (always `length` long, or an error).
 */
async function readExact(
  handle: Awaited<ReturnType<typeof open>>,
  offset: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  let filled = 0
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled)
    if (bytesRead === 0) break
    filled += bytesRead
  }
  if (filled !== length) {
    throw new KomariError(`local file shrank while reading: got ${String(filled)} of ${String(length)} bytes at offset ${String(offset)}`)
  }
  return buffer
}

/**
 * Upload one local file to one machine through the panel's chunked protocol.
 * @param client - authenticated panel client.
 * @param uuid - target machine uuid.
 * @param localPath - path on the machine running dsh.
 * @param remotePath - absolute destination path on the target machine.
 * @param signal - cancellation signal (also carries the transfer deadline).
 * @returns bytes and chunk count actually sent.
 */
export async function uploadLocalFile(
  client: KomariClient,
  uuid: string,
  localPath: string,
  remotePath: string,
  signal?: AbortSignal,
): Promise<UploadOutcome> {
  const info = await stat(localPath).catch((err: unknown) => {
    throw new KomariError(`cannot read local file ${localPath}: ${err instanceof Error ? err.message : String(err)}`)
  })
  if (!info.isFile()) throw new KomariError(`${localPath} is not a regular file`)
  if (info.size > MAX_UPLOAD_BYTES) {
    throw new KomariError(`${localPath} is ${String(info.size)} bytes; the panel accepts at most ${String(MAX_UPLOAD_BYTES)}`)
  }

  const session = await client.uploadInit(uuid, remotePath, info.size, signal)
  if (session.complete) return { bytes: 0, chunks: 0 }

  const chunkSize = session.chunk_size
  const chunkCount = session.chunk_count
  const handle = await open(localPath, 'r')
  try {
    for (let index = 0; index < chunkCount; index += 1) {
      signal?.throwIfAborted()
      const offset = index * chunkSize
      const length = Math.min(chunkSize, info.size - offset)
      const bytes = await readExact(handle, offset, length)
      // Copy into a plain ArrayBuffer-backed view: the fetch body type does not
      // accept Node's ArrayBufferLike-backed Buffer.
      await client.uploadChunk(uuid, session.upload_id, index, Uint8Array.from(bytes), signal)
    }
    await client.uploadMerge(uuid, session.upload_id, signal)
  } catch (err) {
    // Leave no half-written file behind; cleanup failure must not mask the cause.
    try {
      await client.uploadCancel(uuid, session.upload_id)
    } catch {
      // best effort: the session expires on its own after 15 minutes
    }
    throw err
  } finally {
    await handle.close()
  }
  return { bytes: info.size, chunks: chunkCount }
}

/**
 * Download one remote file into the local filesystem, streaming it.
 * @param client - authenticated panel client.
 * @param uuid - source machine uuid.
 * @param remotePath - absolute source path on that machine.
 * @param destPath - local destination path (parent directories are created).
 * @param signal - cancellation signal (also carries the transfer deadline).
 * @returns bytes written plus the resolved path and response metadata.
 */
export async function downloadToLocalFile(
  client: KomariClient,
  uuid: string,
  remotePath: string,
  destPath: string,
  signal?: AbortSignal,
): Promise<DownloadOutcome> {
  const res = await client.downloadStream(uuid, remotePath, signal)
  if (!res.ok) {
    throw new KomariError(`download of ${remotePath} failed (HTTP ${String(res.status)}): ${await client.transferError(res)}`)
  }
  await mkdir(dirname(destPath), { recursive: true })
  const out = createWriteStream(destPath)
  let bytes = 0
  try {
    const body = res.body
    if (body === null) {
      await new Promise<void>((resolve, reject) => {
        out.end(() => resolve())
        out.once('error', reject)
      })
    } else {
      const reader = body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value === undefined) continue
        bytes += value.byteLength
        if (!out.write(Buffer.from(value.buffer, value.byteOffset, value.byteLength))) {
          await once(out, 'drain')
        }
      }
      await new Promise<void>((resolve, reject) => {
        out.end(() => resolve())
        out.once('error', reject)
      })
    }
  } catch (err) {
    out.destroy()
    throw err
  }
  const disposition = res.headers.get('content-disposition') ?? ''
  const filename = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition)?.[1]
  return {
    bytes,
    path: destPath,
    content_type: res.headers.get('content-type'),
    filename: filename === undefined ? null : decodeURIComponent(filename),
  }
}
