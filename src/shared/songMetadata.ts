export interface SongMetadataSearchResult {
  id: string
  title: string
  artist: string
  album?: string
  year?: string
  genre?: string
  releaseGroupId?: string
  score: number
}

type MusicBrainzRecording = {
  id?: string
  title?: string
  score?: number
  'first-release-date'?: string
  'artist-credit'?: Array<{ name?: string; joinphrase?: string }>
  releases?: Array<{
    title?: string
    date?: string
    'release-group'?: { id?: string; 'first-release-date'?: string }
  }>
  genres?: Array<{ name?: string; count?: number }>
  tags?: Array<{ name?: string; count?: number }>
}

function firstYear(...dates: Array<string | undefined>): string | undefined {
  for (const date of dates) {
    const match = date?.match(/^\d{4}/)
    if (match) return match[0]
  }
  return undefined
}

function topName(values?: Array<{ name?: string; count?: number }>): string | undefined {
  return values?.filter((value) => value.name).sort((a, b) => (b.count ?? 0) - (a.count ?? 0))[0]
    ?.name
}

export function parseMusicBrainzSearchResponse(payload: unknown): SongMetadataSearchResult[] {
  const recordings = (payload as { recordings?: MusicBrainzRecording[] })?.recordings
  if (!Array.isArray(recordings)) return []

  return recordings.flatMap((recording) => {
    if (!recording || typeof recording !== 'object' || !recording.id || !recording.title) return []
    const release =
      recording.releases?.find((candidate) => candidate.title) ?? recording.releases?.[0]
    const artist = (recording['artist-credit'] ?? [])
      .map((credit) => `${credit.name ?? ''}${credit.joinphrase ?? ''}`)
      .join('')
      .trim()
    if (!artist) return []

    return [
      {
        id: recording.id,
        title: recording.title,
        artist,
        album: release?.title,
        year: firstYear(
          recording['first-release-date'],
          release?.['release-group']?.['first-release-date'],
          release?.date
        ),
        genre: topName(recording.genres) ?? topName(recording.tags),
        releaseGroupId: release?.['release-group']?.id,
        score: recording.score ?? 0
      }
    ]
  })
}
