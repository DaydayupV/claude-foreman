# Image assets: prompts, backgrounds, slot templates and the assets subcommand

Read this when Codex's images need to become transparent parts, named assets or SVG, or when you edit an image or generate from a reference. The rules in brief are under "Generating images" in SKILL.md.

## 1. The tool's four arguments
Codex's built-in `image_gen` (written `tools.image_gen__imagegen` inside exec) takes four arguments:

| Argument | What it does |
|---|---|
| `prompt` | The prompt, in English |
| `transparent_background` | When `true`, the PNG has a transparency channel |
| `referenced_image_paths` | Absolute paths of local images used as edit or reference inputs; the prompt calls them "Image 1", "Image 2" in order |
| `num_last_images_to_include` | Uses the last 1–5 images in the conversation as input; only for images with no local file |

- Without the last two arguments the tool generates from scratch. Codex looking at the image with view_image first doesn't count as passing it.
- Never pass both of the last two. A slot template and a character sheet are both local files, so both go in `referenced_image_paths`.
- There's no size argument. Output comes in a few sizes of about 1.57 megapixels: 1254×1254 for 1:1, 1536×1024 for 3:2, 1024×1536 for 2:3, 2172×724 for 3:1. Asking for a larger size in the prompt does nothing.
- Reference images are uploaded to the model service with the call.
- `image_calls` in the result lists the arguments each call actually passed; `referenced_image_paths` of `"unknown"` means Codex passed a variable whose paths can't be read, or several calls can't be matched to their images; `status` of `"not_run"` means the call was written in the code but never ran.

## 2. Choosing the background
| Option | When | Notes |
|---|---|---|
| `transparent_background: true` | Default | The transparency is matted afterwards: solid pixels sit at 253–254 and there's a 2–7% faint halo around the edges. `assets cut` by default (`--matte hard`) sets alpha below 48 to 0 and 250 or above to 255; use `--matte soft` for soft-edged assets such as fine hair, smoke or glow |
| Flat magenta #FF00FF | The transparent result has a heavy halo, or the subject is largely white or pale | `transparent_background: false`; the subject must not contain magenta, pink or purple; `assets cut` finds the key color and recovers the edges |
| Green screen, white | Don't use | Green shifts the subject's colors; white can't be removed from areas enclosed by outlines |

## 3. Prompt building blocks
Write in English, in this order: use → aspect ratio → content list → style → background → spacing → exclusions.

Transparent background:
```text
Background: fully transparent everywhere outside the artwork (alpha = 0). No backdrop color, no floor, no cast shadow, no reflection, no glow.
```
Magenta background:
```text
Background: one perfectly flat, uniform pure magenta color (#FF00FF) filling the entire canvas. No gradient, no vignette, no texture, no floor, no cast shadow, no reflection, no glow. Never use magenta, pink, purple or violet anywhere inside the artwork.
```
Spacing (always for several parts):
```text
Spacing: every item is fully separated by a wide empty gap; nothing touches another item or the canvas edge; nothing is cut off.
```
A style that vectorizes well (put it in the generation prompt; asking the model to "make it flat" afterwards barely changes anything):
```text
Style: flat vector illustration, solid color fills with hard crisp edges, bold uniform dark outline (#222222). No gradients, no soft shading, no highlights, no texture, no noise, no 3D, no drop shadows, no glow.
Palette: use only these colors: #222222, #FFFFFF, #F5A524, #1D5B79, #E9C25A.
```
For complex subjects such as characters, replace the first line with "clean anime cel shading as flat vector art: solid fills, exactly one hard-edged shadow tone per color".
Exclusions:
```text
No text, no letters, no numbers, no labels, no grid lines, no frames, no watermark.
```
For background layers that scroll in a loop (distant mountains, cloud bands, ground), ask for a strip whose left and right edges join seamlessly instead of building one afterwards from "original + horizontal mirror": the mirror symmetry is easy to spot.
```text
Tiling: this is a horizontally repeating strip. The left and right edges must continue into each other seamlessly (the same height and shapes at both edges), so copies placed side by side show no seam. Do not make it mirror-symmetric.
```

## 4. Several parts: name them with a slot template
The model usually lays parts out in the listed order, but not always. To refer to parts by name, use a slot template:
1. `assets template --out <path in the project>/layout.png --cols 4 --rows 2 --names "head,hair-back,…"`, which also writes `layout.slots.json`. Keep the template inside the project so Codex's sandbox can read it.
2. Pass the template as Image 1 (and a character sheet as Image 2 if there is one):
```text
Image 1 is a layout template: 8 numbered dashed slots in two rows. Image 2 is the character design sheet.
Draw <content> as SEPARATE parts. Put exactly one part centered inside each slot of Image 1, fitting inside the slot:
slot 1: <part 1>
slot 2: <part 2>
...
Do NOT draw the dashed slot outlines or the slot numbers.
<style, background, exclusions>
```
3. `assets cut --image <image> --out <dir> --slots layout.slots.json`: each part is named after the slot its center falls in; separate pieces in one slot (the rays of a sun, the drops under a cloud) are merged into one part.

Use stable English ids as names (they become the file names), and say whether "left" and "right" mean the character's or the viewer's. The more slots on one image, the smaller each part: with 12 slots each is about 250 pixels wide.

## 5. Whole image first, or a parts sheet directly
- **A parts sheet directly**: independent assets that are never assembled, such as icon sets, buttons and badges, props.
- **The whole image first, checked, then split**: anything that must keep one design, such as a full UI page split into components, scene layers, or the props that go with one character. Pass the whole image as the reference when splitting, and list the details that must be kept. In testing, splitting with a reference kept details such as the cap, hair clip and cape, while a text-only description lost them. Each piece is then used as a rigid piece in the work, as in section 6.
- Give small icons inside a component (the icons in a navigation bar) their own slots or their own image; don't expect a second level of splitting out of a full page.
- Extending an existing set: pass the existing set as the reference, ask for "exactly the same drawing style, outline weight, corner rounding, level of detail, proportions and palette as Image 1", and add "Do not copy any item from Image 1".

## 6. Using it in SVG, HTML and animations
When the final work is code, decide each piece by "Decide per piece" in SKILL.md: pieces that move as a whole, with joins that are covered or don't move, are generated; pieces that bend themselves, whose joins would show as they turn, or that must touch something drawn in code exactly are drawn by Claude; physics simulation, mechanics, text, UI controls and geometric shapes are drawn in code. One character can mix them.
1. **List the pieces**: for each visible piece, write down how it moves (still, moved or turned as a whole, bending), what it meets, what covers the join, and whether it touches something drawn in code; that decides generated, hand-drawn or code-drawn. Before starting, tell the user the outcome in a sentence or two. Put joins where the reference already covers them, and keep clothing and accessories that move with a piece (sleeves, trouser hems, gloves) with that piece; don't take out of a generated piece a piece that sits inside it or in front of it, or the model draws the opening and inner rim that were never visible; and don't ask it to remove a piece and finish the edge left behind (rounding off a shoulder after removing the arm), because it doesn't. Put the join on the edge of something that already covers it in the reference (a strap, a collar, a cuff, a counter), keep that side exactly as it is when taking the piece out, and let the hand-drawn parts, traced from the reference, cover the short stretch next to the join.
2. **Generate the overall reference image**: the whole character or the whole scene, with the final composition, colors and style. Write the prompt from the template below, deriving every line from the piece list in step 1 and phrasing it as something visible in the picture; don't put a list of pieces or how to split them in the prompt, and avoid words such as puppet, parts, joint, pivot or separate, which make the model draw a parts sheet or jointed limbs with cut faces. Once approved, it is the reference for every piece.
```text
<subject, action and composition>
Composition for animation:
- <each moving piece> is fully visible and does not overlap <the nearby pieces it must stay apart from>.      (one line per moving piece from step 1)
- <what covers each join>, e.g. the collar covers the neck, the cuff wraps the wrist, <an object in front> hides everything below the waist.
- <each moving piece> is drawn in the middle of its motion: <middle pose>.
- <moving pieces> cast no shadow on other parts; no glow, light rays or sparkles cross between objects.
- Do not draw <what code draws: steam, particles, reflections, text, UI>; leave <places for text> blank.
Style: clean anime cel shading as flat vector art (the style block in section 3), bold outline of the same weight everywhere (<outline color>).
Detail: the same level of detail everywhere: <detailed areas such as hair and clothes> drawn with a few large simple shapes, not many thin strands or fine lines. <pieces to be hand-drawn> are flat colors with exactly one hard-edged shadow tone, no gradients.
Palette: <palette>.
<background block; opaque for a whole scene>
No text, no letters, no numbers, no labels, no grid lines, no frames, no watermark.
```
3. **Generated pieces**:
   - Pieces that stay where they are in the reference (the background plate, parts of a character that don't move): pass the reference as Image 1 and take them out one at a time with the layer prompts in section 7, adding "complete the parts hidden behind <what covers it> naturally" and, for the end that meets another piece, "continue it a little past the join, where <neighboring piece> will cover it". An opaque background plate mostly keeps its place; a single piece on a transparent background often comes back enlarged and re-centered (1.16–1.86 times in testing), so put every piece back with `assets align --ref <reference> --image <piece> --out <dir> --regions <rectangles at the joins>` and place it with the scale and offset it reports, or use the same-canvas `aligned.png`. If the color difference at a join region is high, or the check image shows red around the join, the join was redrawn: regenerate, and don't move the hand-drawn parts to fit.
   - Pieces that change pose or state, or go somewhere else: the slot template as Image 1 and the reference as Image 2 (section 4).
   - In the work, each one only moves as a whole.
4. **Local variants (a blink, an open mouth)**: pass the original piece as Image 1 and change only that spot with the partial-edit prompt in section 7; then run `assets patch --base <original piece> --variant <edited image> --out <dir>`: it puts the edited image back onto the original (edits often come back enlarged or moved; when the fit is uncertain it keeps the original position), drops slight outline shifts and changes along the outer silhouette, keeps only solid areas of change, and writes a feathered `patch.png` on the original's canvas (lay it straight over), the combined `preview.png` and a check image. When you know which area to take, add `--keep <region>`. Don't swap whole images: in testing, swapping the whole image moved the outlines of the whole head by about a pixel besides the eyes, with more than 6,000 pixels jumping at real size; with only an eye patch, the change shrank to a few hundred pixels inside the eyes.
5. **Hand-drawn parts**: use this piece's outline and shading shapes in the reference as the base drawing: `assets trace --image <reference> --seed <a point in the piece's fill> --box <a rectangle around the piece> --out <dir>` fills out the piece from the seed, splits it into outline, base color and shadow (`--colors` sets the number of fill tones), and writes `trace.svg` in reference coordinates (one `<path>` per layer; fine inner lines are holes in the fill) and a check image; if it takes too much or too little, move the seed, tighten `--box` or adjust `--tolerance`. Then animate the traced shapes, with the reference's colors and shading levels. Match the line weight to the generated pieces: measure how many pixels the outline is in the generated image and multiply by the piece's scale in the scene. For limbs that bend, draw all the outlines first and then all the fills, so the fills cover the inner outlines at the joints and bending leaves no seam; the end that meets a generated piece goes under it.
6. **SVG or not**: turn flat assets with few colors into SVG with `assets cut --vector`; ask for a flat style with little shading when generating, and add `--colors 8` to `12` when vectorizing, which roughly halves the path count; use `--palette … --snap` to fix the colors. Keep characters and images with gradients or much detail as PNG, embedded with `<image>` in the SVG or page: without color reduction an anime character part has tens to five hundred paths, which stutters on a web page, and reducing colors leaves bands.
7. **Assemble and check**: `layers.svg` has every part in its own `<g id>` at its place in the source image; individual `parts/<name>.svg` or `parts/<name>.png` files can be used too. `crop` in `manifest.json` is only the part's place in the source image; where it goes on the page is set in code. The page must support `?t=<seconds>` to stop at a given moment (screenshots and checks depend on it). After assembling, use `assets capture --url <page> --times <seconds,…> --size <display size> --zoom <name=rectangle at a join;…> --out <dir>` to take a few key moments at the real display size (both ends of a motion, when something passes in front of something else, when a variant shows) with 2x close-ups, and look at the joins, anything that looks detached, and whether the generated and hand-drawn parts have similar detail. For an animation, also capture one loop with `assets playback --url <page> --loop <seconds per loop> --static <regions that should not move;…> --out <dir>`: a change inside a `static` region is flicker, a non-zero `seam` means the loop doesn't join, and `jumps` lists moments that suddenly jump; give the user `playback.png` (an APNG that plays in a browser) to watch. Screenshots need the local Chrome or Edge; if neither is found, point to one with `--browser`. Before delivering an animation, it's best to have a model that didn't make it look at the screenshots too.
8. **Why it's split this way** (October 2026 trials):
   - Joint parts sheets: the model didn't follow the scale and joint positions in the slots (off by 20–40% of the slot size), and it outlined every joint end. Assembled and rotated, they looked like a ball-jointed doll; swapping the layer order only changed which seam showed.
   - Frames from a pose guide: within one strip the character stayed consistent and the joints looked natural, but contact with things drawn in code didn't line up: 6 of 8 frames were off (in the cycling trial, the foot missed the pedal by a fraction of a shoe length), and a filled silhouette guide with a written action per frame didn't help.
   - Two halves from two generations that had to join didn't match at the seam.
   - A generated head on a hand-drawn body: the join, covered by the chin and hair, didn't show; the main problem was that the head was far more detailed than the body.
   - Reference-prompt comparison: a reference written from the template in step 2 had much less hair detail and fewer gradients, the tail tip to be hand-drawn turned from gradient fluff into flat color, and the detail gap between generated and hand-drawn parts shrank by about 60%; but in both arms, taking the body out ignored "remove the raised arm with its whole sleeve and round off the shoulder": one left an empty sleeve, the other redrew the sleeve hanging down.
   - Two scene tests: taking the body out of the reference with "remove the waving arm" redrew the cuff as an opening with an inner rim, about 50 pixels lower, so the hand-drawn arm had to bend to fit and the join showed at a glance; single pieces on a transparent background came back enlarged 1.16–1.86 times; background strips built by mirroring showed their symmetry.
9. **Frame-by-frame sprites (experimental, only when the user explicitly asks)**: only for looping motions that touch nothing else. Generate one horizontal strip per action (4–8 frames), with the reference image and a layout guide drawn in code (the cells and a pose silhouette per frame) as references; cut the whole strip at one scale without re-centering each frame, and align frames on parts that don't move; look at each strip as soon as it's done and redo only the bad one. The loop seam and flicker during playback haven't been verified, so let the user watch it play before delivering.

## 7. Edits and layers
- **A partial change**: the original as Image 1, and "Change ONLY <target and position>: <change>. Keep every other part exactly unchanged: same parts, same positions, same sizes, same colors, same line art, and the same background." An edit slightly changes other areas too (an average color difference of 2–3 in testing); check with `assets diff --before <original> --after <new> --slots <template>` that only the target slot changed, and when delivering replace only that part.
- **Scene layers, taking pieces out**: the background plate (`transparent_background: false`) says "Remove <subject> completely and fill that area with the background that would be behind them … Change nothing else: same canvas size, same composition and framing"; the subject layer (`true`) says "keep only <subject> exactly as they appear: same pose, same position in the frame, same scale … Same canvas size". In testing the two layers put back together matched the original closely, but the ground shadow was in neither layer; say in the brief which layer it belongs to, or make it a layer of its own.
- **Removing the background from an existing image**: the original as Image 1, "Remove only the background and make it fully transparent. Keep <subject> exactly as they are … Do not redraw or restyle anything."
- Changes build up over several rounds of edits to the same image; after two or three, regenerate from the source.

## 8. The assets subcommand
Runs locally, calls no model, and prints JSON.

| Command | What it does |
|---|---|
| `template --out <png> --cols C --rows R [--aspect 1:1\|3:2\|2:3\|3:1] [--names a,b,…]` | Draws a numbered, dashed slot template and its `.slots.json` (slot positions are stored as fractions, so a different output size still works). Without `--aspect`, it picks one from the columns and rows |
| `cut --image <png> --out <dir> [options]` | Removes the background, splits parts, names them, writes a contact sheet and a manifest |
| `check --dir <cut output dir>` | Re-reads the verdict; exits with 1 when anything failed |
| `diff --before <png> --after <png> [--slots <json>]` | The average color difference `mean_delta` and changed-pixel share `changed`, overall and per slot |
| `align --ref <png> --image <png> --out <dir> [--regions x0,y0,x1,y1;…] [--min-scale <factor>] [--max-scale <factor>]` | Puts a piece taken out of the reference back onto it: the uniform `scale` and `offset` (pixel (x, y) of the piece lands at offset + scale·(x, y) in the reference), the overall average color difference `mean_delta` and matched share `matched`, `ambiguous` (true when the result isn't reliable: the piece is small or has few features, or the result sits at the edge of the scale range; see `note`), and the color difference of each region (in reference pixels); writes `aligned.png` on the reference's canvas, the three-panel check image `check.png` (reference / piece laid over it / difference, where gray matches, orange differs somewhat and red differs clearly) and `align.json` |
| `patch --base <png> --variant <png> --out <dir> [--keep x0,y0,x1,y1;…] [--threshold <difference>] [--min-area <px>] [--open <px>] [--edge <px>] [--grow <px>] [--feather <px>]` | Takes only the changed region of an edited image: puts the edit back onto the original (keeping the original position when the fit is uncertain), ignores changes within `--edge` (default 6) pixels of the original's outer silhouette, removes slight outline shifts with an opening of `--open` (default 2), drops pieces smaller than `--min-area`, grows by `--grow` and feathers by `--feather`, and writes `patch.png`, `preview.png`, `check.png` and `patch.json` (patch `box`, pixel counts, alignment). It can't cover places where the edit removed something |
| `trace --image <png> --seed x,y;… --out <dir> [--box x0,y0,x1,y1] [--tolerance <difference>] [--colors <n>] [--outline <px>] [--dark <lightness>] [--simplify <px>]` | Traces a piece from the reference: fills out the colors near the seed (`--tolerance`, default 30), takes dark pixels (lightness below `--dark`, default 25) within `--outline` (default 4) pixels of the fill as the outline, splits the fill into `--colors` (default 2) tones, and writes `trace.svg` in reference coordinates (outline, base and shadow layers), `trace.json` and a check image |
| `capture --url <url or file> --times <seconds,…> --out <dir> [--size WxH] [--scale <factor>] [--zoom name=x0,y0,x1,y1;…] [--param t] [--wait <ms>] [--browser <path>]` | Takes a screenshot per moment with the local Chrome or Edge in headless mode by adding `?t=<seconds>` to the page URL (`--scale` defaults to 2), crops close-ups in CSS pixels, and writes the contact sheet `sheet.png` and `capture.json`; a screenshot that is one flat color is retried with a longer wait |
| `playback --url <url or file> --loop <seconds> --out <dir> [--fps <n>] [--static name=x0,y0,x1,y1;…] [--size WxH] [--scale <factor>] [--preview-width <px>] [--browser <path>]` | Captures one loop at `--fps` (default 12), plus a last frame to compare with the first; computes the change between neighboring frames, inside `static` regions (flicker), between the ends (`seam`) and sudden spikes (`jumps`); writes the frames in `frames/`, a playable `playback.png` (APNG), the flipbook `flipbook.png` and `playback.json` |
| `setup` | Installs the two native packages for vectorizing into `~/.claude/foreman/tooling` (ask the user first) |

Options of `cut`:
- `--slots`, `--names`: name by slot or by the name list (with a template, the Nth name belongs to the Nth slot in the slots file; names written in the template follow slot numbers, so merged slots or gaps in the numbering don't shift them).
- `--matte hard|soft`: how a transparent image is cleaned; see section 2.
- `--key auto|#rrggbb`: the key color of a flat background, by default the median color of the canvas edge; for a white or light gray background only the part connected to the edge is removed.
- `--gap <px>` (default 6): pieces closer than twice the gap belong to one part. `--min-area <share>` (default 0.0004): smaller specks are dropped.
- `--palette "#rrggbb,…"`: counts how much of each part falls on the palette; add `--snap` to snap colors to the palette (shades outside the palette are snapped away, so add them to the palette to keep them).
- `--colors N`: reduces the whole image to one shared N-color palette before cutting, for fewer vector paths.
- `--vector`: also converts to SVG, writing `parts/<name>.svg` and `layers.svg`, which has every part at its original position in its own `<g id>` (it opens in Figma or Illustrator as layers). Run `setup` first.
- `--allow-edge`: for assets meant to span the full width (parallax background layers), touching the edge isn't a failure.

Outputs of `cut`: `alpha.png` (the whole image with the background removed), `parts/<name>.png`, `sheet.png` (the contact sheet, slot numbers in the top left; with SVG, the original on the left and the SVG render on the right), `manifest.json` (each part's id, slot, files and its place in the source image as `crop`; assembly positions aren't guessed) and `report.json`.

`checks` in `report.json`:
| id | Status | Meaning |
|---|---|---|
| `names` | fail | A part from the name list is missing, or there are extra unnamed parts |
| `slots` | fail | Some part isn't inside any slot |
| `merged` | needs_review | Pieces in some slot were merged; check on the contact sheet that they belong together |
| `edge` | fail (needs_review with `--allow-edge`) | A part touches the canvas edge and may be cropped |
| `transparency` | fail | Under 5% of pixels are transparent; the background probably wasn't removed |
| `background` | needs_review | The flat background isn't flat enough; edges may keep some of it |
| `specks` | needs_review | Specks were dropped |
| `vector` | needs_review | Some part's SVG outline overlaps the image by less than 0.95 (IoU) |

Other figures: `halo` (halo share before cleaning), `transparent`, `edge_width` (width of the semi-transparent edge, 1–3 pixels is normal), `background_p99`, and per part `colors95` (how many colors cover 95% of the pixels; fewer vectorizes better), `on_palette`, `paths`, `iou`, `color_error`. These figures come from a few dozen images in October 2026 and are rules of thumb, not hard limits.

## 9. What it can't do or hasn't been verified
- Pixel art, exact pixel sizes, and high-resolution images above about 1.57 megapixels.
- Joint motion and exact alignment: see section 6; testing showed it can't be done.
- `assets align` only finds a uniform scale and a shift, not rotation; if the model turned the piece, it won't line up and has to be regenerated.
- Parts carry no layer or draw order; that's set in code, and the manifest doesn't have it.
- Semi-transparent assets (glass, smoke) only get the rough `--matte soft` treatment and haven't been tested systematically.
- How the layered SVG behaves after import into Figma or Illustrator (groups, editability) hasn't been checked in practice.
