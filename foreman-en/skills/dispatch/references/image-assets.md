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
- **The whole image first, checked, then split**: anything that must keep one design, such as a character split into parts, a full UI page split into components, or scene layers. Pass the whole image as the reference when splitting, and list the details that must be kept. In testing, splitting with a reference kept details such as the cap, hair clip and cape, while a text-only description lost them.
- For character parts that need to rotate, add:
```text
Each part is drawn complete and whole on its own (including the areas normally hidden by overlapping parts), with rounded overlap ends at the joints so it can pivot.
```
- Give small icons inside a component (the icons in a navigation bar) their own slots or their own image; don't expect a second level of splitting out of a full page.
- Extending an existing set: pass the existing set as the reference, ask for "exactly the same drawing style, outline weight, corner rounding, level of detail, proportions and palette as Image 1", and add "Do not copy any item from Image 1".

## 6. Using it in SVG, HTML and animations
When the final work is code, illustrations are still drawn by Codex and vectorized into SVG parts before going into the code; don't generate a "reference only" image for Claude to redraw by hand.
1. **Generate the whole design sheet first and check it**: the character from the front and the side, or the whole scene. Every part afterwards uses it as the reference, so the design stays the same.
2. **List the elements and decide each one**: shapes the work needs simulated by physics every frame (simulated hair and cloth, procedural ropes), things tied to mechanics or physics (chains, gears, cranks), text and UI controls, and geometric shapes are drawn in code; everything else goes on the parts sheet. Elements drawn in code follow the design sheet's colors and line weight.
3. **Generate the parts sheet**: the slot template as Image 1, the design sheet as Image 2, transparent background. Split parts for animation like this:
   - Split at the joints, add "with rounded overlap ends at the joints so it can pivot" to the prompt, and ask for each part "drawn complete and whole on its own", including what's normally hidden.
   - Cut parts that bend or flow but don't need per-frame simulation into segments (hair, a tail or a cape into 3–4 each, the default), one slot per segment, turned in sequence.
   - Give each expression or state its own slot, at the same size and angle as the base part:
```text
slot 9: the same head as slot 1 with the mouth open, drawn at exactly the same size, angle and position in its slot
slot 10: the same head as slot 1 with the eyes closed (blink), drawn at exactly the same size, angle and position in its slot
```
   - If one image can't hold everything, use several, each with the design sheet as a reference.
4. **Vectorize**: `assets cut --slots … --vector`. Ask for a flat style with little shading when generating, and add `--colors 8` to `12` when vectorizing, which roughly halves the path count; without color reduction an anime character part has tens to five hundred paths, and many parts on a web page can stutter. Use `--palette … --snap` to fix the colors.
5. **Assemble**: `layers.svg` has every part in its own `<g id>` at its place in the source image; individual `parts/<name>.svg` files can be used too. `crop` in `manifest.json` is only the part's place in the source image; the assembly position and the pivot (the center of the round joint end) are set in code.

## 7. Edits and layers
- **A partial change**: the original as Image 1, and "Change ONLY <target and position>: <change>. Keep every other part exactly unchanged: same parts, same positions, same sizes, same colors, same line art, and the same background." An edit slightly changes other areas too (an average color difference of 2–3 in testing); check with `assets diff --before <original> --after <new> --slots <template>` that only the target slot changed, and when delivering replace only that part.
- **Scene layers**: the background plate (`transparent_background: false`) says "Remove <subject> completely and fill that area with the background that would be behind them … Change nothing else: same canvas size, same composition and framing"; the subject layer (`true`) says "keep only <subject> exactly as they appear: same pose, same position in the frame, same scale … Same canvas size". In testing the two layers put back together matched the original closely, but the ground shadow was in neither layer; say in the brief which layer it belongs to, or make it a layer of its own.
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
| `setup` | Installs the two native packages for vectorizing into `~/.claude/foreman/tooling` (ask the user first) |

Options of `cut`:
- `--slots`, `--names`: name by slot or by the name list (with a template, the Nth name belongs to slot N).
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
- Parts carry no rig data: layer order, draw order and pivots are set in code; the manifest doesn't have them.
- Semi-transparent assets (glass, smoke) only get the rough `--matte soft` treatment and haven't been tested systematically.
- How the layered SVG behaves after import into Figma or Illustrator (groups, editability) hasn't been checked in practice.
