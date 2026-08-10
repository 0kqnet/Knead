import { describe, expect, it } from 'vitest'
import {
  createReferenceAudioTrackDraft,
  decodeReferenceAudioBase64,
  encodeReferenceAudioBase64,
  hasReferenceAudioMagic,
  readReferenceAudioFileData,
  referenceAudioFingerprint,
} from './referenceAudio'

describe('reference audio import safety', () => {
  const wav = Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0,
    0x57, 0x41, 0x56, 0x45, 1, 2, 3, 4,
  ])

  it('round-trips bytes and creates deterministic portable metadata', () => {
    const dataBase64 = encodeReferenceAudioBase64(wav)
    expect(decodeReferenceAudioBase64(dataBase64, wav.length)).toEqual(wav)
    const file = {
      path: 'C:\\audio\\guide.wav',
      fileName: 'guide.wav',
      mimeType: 'audio/wav' as const,
      byteLength: wav.length,
      dataBase64,
    }
    const bytes = readReferenceAudioFileData(file)
    const track = createReferenceAudioTrackDraft(file, bytes, 2.5)
    expect(track).toMatchObject({
      name: 'guide',
      fingerprint: referenceAudioFingerprint(wav),
      durationSeconds: 2.5,
      offsetTicks: 0,
    })
  })

  it('rejects extension/header mismatches and incorrect declared sizes', () => {
    expect(hasReferenceAudioMagic(wav, 'audio/wav')).toBe(true)
    expect(hasReferenceAudioMagic(wav, 'audio/ogg')).toBe(false)
    const dataBase64 = encodeReferenceAudioBase64(wav)
    expect(() => readReferenceAudioFileData({
      path: 'guide.ogg',
      fileName: 'guide.ogg',
      mimeType: 'audio/ogg',
      byteLength: wav.length,
      dataBase64,
    })).toThrow('Ogg')
    expect(() => decodeReferenceAudioBase64(dataBase64, wav.length - 1)).toThrow('Base64')
  })
})
