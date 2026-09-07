# Music Bed Credits

All bed tracks under this directory are released under **Creative Commons CC0 1.0
Universal** (public domain — no attribution required, commercial use permitted).

Source: https://freepd.com/ — mirrored in https://github.com/SoundSafari/CC0-1.0-Music

Each file is a 60-second, 48 kHz, mono, 96 kbps MP3 excerpt (fades applied) taken
from a longer CC0 track. The `mixWithMusicBed()` pipeline loops it under narration
with highpass + corrective EQ + gentle compression and alimiter; see
`services/audiobookGenerator.js`.

| File                       | Source track                    | Intended mood |
|----------------------------|---------------------------------|---------------|
| ambient-calm.mp3           | Kalimba Relaxation Music        | calm          |
| ambient-playful.mp3        | Happy Whistling Ukulele         | playful       |
| ambient-curious.mp3        | Magic in the Garden             | curious       |
| ambient-tender.mp3         | Lovely Piano Song               | tender        |
| ambient-suspense.mp3       | Lurking Sloth                   | light suspense (child-safe) |
| ambient-triumph.mp3        | Heroic Adventure                | triumph       |
| ambient-bedtime.mp3        | Landra's Dream                  | bedtime       |
| ambient-bittersweet.mp3    | Nostalgic Piano                 | bittersweet   |
| ambient-light.mp3          | Funshine                        | default / generic warm |

To swap a mood: replace the corresponding `ambient-<mood>.mp3` with any 30–90 s
mono or stereo MP3. `pickMusicPath` in `services/audiobookGenerator.js` resolves
`(musicMood, genre)` → file via `MOOD_MUSIC` / `GENRE_MUSIC`.
