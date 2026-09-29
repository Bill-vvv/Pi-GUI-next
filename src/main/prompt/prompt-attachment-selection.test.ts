import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PhotonImage } from '@silvia-odwyer/photon-node'

import { readPromptAttachments } from './prompt-attachment-selection.ts'

function png(width: number, height: number, noisy = false): Buffer {
  const pixels = new Uint8Array(width * height * 4)
  let seed = 1
  for (let index = 0; index < pixels.length; index += 4) {
    if (noisy) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      pixels[index] = seed & 0xff
      pixels[index + 1] = (seed >> 8) & 0xff
      pixels[index + 2] = (seed >> 16) & 0xff
    } else {
      pixels[index] = (index / 4) % 256
      pixels[index + 1] = 128
      pixels[index + 2] = 64
    }
    pixels[index + 3] = 255
  }
  const image = new PhotonImage(pixels, width, height)
  try {
    return Buffer.from(image.get_bytes())
  } finally {
    image.free()
  }
}

/** Minimal uncompressed 24-bit BMP. */
function bmp(width: number, height: number): Buffer {
  const rowSize = Math.ceil((width * 3) / 4) * 4
  const pixelBytes = rowSize * height
  const buffer = Buffer.alloc(54 + pixelBytes)
  buffer.write('BM', 0, 'ascii')
  buffer.writeUInt32LE(buffer.length, 2)
  buffer.writeUInt32LE(54, 10)
  buffer.writeUInt32LE(40, 14)
  buffer.writeInt32LE(width, 18)
  buffer.writeInt32LE(height, 22)
  buffer.writeUInt16LE(1, 26)
  buffer.writeUInt16LE(24, 28)
  buffer.writeUInt32LE(pixelBytes, 34)
  buffer.fill(0x7f, 54)
  return buffer
}

async function withFiles(
  files: Record<string, Buffer | string>,
  run: (paths: Record<string, string>) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-attachments-'))
  try {
    const paths: Record<string, string> = {}
    for (const [name, content] of Object.entries(files)) {
      paths[name] = join(directory, name)
      await writeFile(paths[name]!, content)
    }
    await run(paths)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('small images are kept byte for byte and other files stay file references', async () => {
  const small = png(32, 24)
  await withFiles({ 'small.png': small, 'notes.txt': 'hello', 'empty.bin': Buffer.alloc(0) }, async (paths) => {
    const attachments = await readPromptAttachments([paths['small.png']!, paths['notes.txt']!, paths['empty.bin']!])
    assert.deepEqual(attachments, [
      {
        type: 'image',
        name: 'small.png',
        path: paths['small.png'],
        image: { type: 'image', mimeType: 'image/png', data: small.toString('base64') },
        hints: []
      },
      { type: 'file', name: 'notes.txt', path: paths['notes.txt'] }
    ])
  })
})

test('oversized images are resized within 2000px with the coordinate hint', async () => {
  await withFiles({ 'wide.png': png(3000, 1000) }, async (paths) => {
    const [attachment] = await readPromptAttachments([paths['wide.png']!])
    assert.equal(attachment?.type, 'image')
    if (attachment?.type !== 'image') return
    assert.equal(attachment.image.mimeType, 'image/png')
    const decoded = PhotonImage.new_from_byteslice(Buffer.from(attachment.image.data, 'base64'))
    try {
      assert.deepEqual([decoded.get_width(), decoded.get_height()], [2000, 667])
    } finally {
      decoded.free()
    }
    assert.deepEqual(attachment.hints, [
      '[Image: original 3000x1000, displayed at 2000x667. Multiply coordinates by 1.50 to map to original image.]'
    ])
  })
})

test('images above the inline byte limit fall back to JPEG and shrink until they fit', async () => {
  await withFiles({ 'noise.png': png(1900, 1900, true) }, async (paths) => {
    const [attachment] = await readPromptAttachments([paths['noise.png']!])
    assert.equal(attachment?.type, 'image')
    if (attachment?.type !== 'image') return
    assert.equal(attachment.image.mimeType, 'image/jpeg')
    assert.ok(Math.ceil(Buffer.from(attachment.image.data, 'base64').length / 3) * 4 < 4.5 * 1024 * 1024)
  })
})

test('BMP images are always converted and say so', async () => {
  await withFiles({ 'shot.bmp': bmp(40, 30) }, async (paths) => {
    const [attachment] = await readPromptAttachments([paths['shot.bmp']!])
    assert.equal(attachment?.type, 'image')
    if (attachment?.type !== 'image') return
    assert.equal(attachment.image.mimeType, 'image/png')
    assert.deepEqual(attachment.hints, ['[Image converted from image/bmp to image/png.]'])
  })
})

test('undecodable and unsupported images are rejected', async () => {
  const corrupt = Buffer.concat([png(8, 8).subarray(0, 40), Buffer.alloc(64)])
  const jpegLs = Buffer.from([0xff, 0xd8, 0xff, 0xf7, 0, 0, 0, 0])
  await withFiles({ 'corrupt.png': corrupt, 'lossless.jpg': jpegLs }, async (paths) => {
    await assert.rejects(readPromptAttachments([paths['corrupt.png']!]), /Could not decode image file/u)
    await assert.rejects(readPromptAttachments([paths['lossless.jpg']!]), /Unsupported image file/u)
  })
})
