# LyricTok Studio

Run `start_app.bat` to open the local studio with MP4 export support.

## Lyric animations

Choose from 22 intentional presets. The original twelve are **Indie Film**, **Flow Scroll**, **Still Lyrics**,
**Soft Fade**, **Line Rise**, **Word Reveal**, **Karaoke Fill**, **Typewriter**,
**Word Pop**, **Solo Word**, **Poster Stack**, and **Slide Cut**. Indie Film and Flow
Scroll retain their original rendering. The generated remix catalog has been removed.

The **New** filter shows ten additions: **Center Reveal**, **Underline Follow**,
**Focus Pull**, **Letter Cascade**, **Word Reel**, **Split Verse**, **Masked Rise**,
**Final Word**, **Staircase**, and **Elastic Assemble**. They include cinematic
reveals, vocal tracking, and distinct word compositions, with no continuous loops.

Each new preset uses phrase or word timestamps, with no random letters, cloned text,
or decorative stage effects. **Match Beat** selects one preset for the current phrase
and leaves your font, size, case, colors, and position unchanged. Animations follow
the playhead, including while paused or scrubbing. Reduced motion preferences apply
to the new animation previews; exports retain the selected animation.

Run the animation timing and layout checks with `node --test tests/lyric-animations.test.js`.

## Lyric fonts and sizing

Choose from 61 fonts in **Lyric Style**, organized by song mood. Use **Song Mood**
to show matching suggestions, or **All moods** to browse the complete collection.
Filtering keeps your current font until you choose a preview.

The ten moods are **Hype & energetic**, **Happy & playful**, **Romantic & warm**,
**Sad & emotional**, **Chill & dreamy**, **Angry & rebellious**, **Dark & mysterious**,
**Retro & nostalgic**, **Futuristic & electronic**, and **Acoustic & intimate**.
The playful group includes all 17 cartoon and comic choices. Other moods include
new options such as Great Vibes, Lora, Comfortaa, Metal Mania, Creepster, Monoton,
Orbitron, and Indie Flower.
The font picker previews each name in its actual typeface. Use arrow keys to
browse, type a font name to jump to it, and press Enter to select or Escape to close.
Web fonts load from Google Fonts when
online, with system font fallbacks when offline.

Use the **Font Size** slider or number field to set 32–500 px on the output
canvas. Try Lilita One or Anton at 180–320 px for large, stacked lyrics, or
Caveat and Dancing Script for handwritten edits. Long words automatically
shrink to fit the canvas width.

## Lyrics behind a person

1. Upload a background video and add your timed lyrics.
2. In **Lyric Style**, enable **Lyrics behind person**.
3. Adjust **Mask edge softness** and the lyric vertical position as needed.
4. Preview or export your MP4. The person covers any overlapping lyrics.

Person masking runs in a browser worker using the bundled MediaPipe model. It
does not upload video or require a network connection. Export waits for the mask
for each source frame, so masking can increase export time.

The automatic mask works best with clearly visible people. Hair, motion blur,
occlusion, and animated or nonhuman characters can produce imperfect edges.
Background images and procedural themes continue to display lyrics normally.

Third-party runtime and model provenance: [vendor/mediapipe/README.md](vendor/mediapipe/README.md).
"# lyrics-visualizer" 
