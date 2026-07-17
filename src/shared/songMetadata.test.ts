import { describe, expect, it } from 'vitest'
import { parseMusicBrainzSearchResponse } from './songMetadata'

describe('parseMusicBrainzSearchResponse', () => {
  it('maps recording, release, genre, date, and artist credit fields', () => {
    expect(
      parseMusicBrainzSearchResponse({
        recordings: [
          {
            id: 'recording-id',
            title: 'Under Pressure',
            score: 100,
            'first-release-date': '1981-10-26',
            'artist-credit': [{ name: 'Queen', joinphrase: ' & ' }, { name: 'David Bowie' }],
            genres: [
              { name: 'rock', count: 4 },
              { name: 'pop', count: 2 }
            ],
            releases: [
              {
                title: 'Hot Space',
                date: '1982-05-21',
                'release-group': { id: 'release-group-id', 'first-release-date': '1982-05-21' }
              }
            ]
          }
        ]
      })
    ).toEqual([
      {
        id: 'recording-id',
        title: 'Under Pressure',
        artist: 'Queen & David Bowie',
        album: 'Hot Space',
        year: '1981',
        genre: 'rock',
        releaseGroupId: 'release-group-id',
        score: 100
      }
    ])
  })

  it('drops malformed recordings', () => {
    expect(parseMusicBrainzSearchResponse({ recordings: [{ title: 'No ID' }, null] })).toEqual([])
    expect(parseMusicBrainzSearchResponse(null)).toEqual([])
  })
})
