# Image assets: prompts, backgrounds, slot templates and how they work in code

The image module's workflow and rules are in `references/image.md`; read that first. This file has what writing an image brief needs: prompts, backgrounds, slot templates, the whole workflow for code work, and edits. The options of the `assets` subcommand are in `references/assets-cli.md`. Section numbers are kept from the old version (section 0 moved to image.md and section 8 to assets-cli.md).

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
- **The whole image first, checked, then split**: anything that must keep one design. Characters and scenes in code work take their pieces from the final image as in section 6, not split by the model. For assets used on their own, such as a full UI page split into components or the props that go with one character, pass the whole image as the reference for a separate parts sheet, and list the details that must be kept. In testing, parts drawn with a reference kept details such as the cap, hair clip and cape, while a text-only description lost them.
- Give small icons inside a component (the icons in a navigation bar) their own slots or their own image; don't expect a second level of splitting out of a full page.
- Extending an existing set: pass the existing set as the reference, ask for "exactly the same drawing style, outline weight, corner rounding, level of detail, proportions and palette as Image 1", and add "Do not copy any item from Image 1".

## 6. Using it in SVG, HTML and animations
The rule behind everything: two areas of pixels that meet must come from the same image, or one side must be drawn in code. So when Codex generates images it draws whole pictures and never single pieces, and every piece of the work comes from one final image: Claude cuts the pieces that move as a whole locally, and Codex hand-draws the pieces that bend as paths traced from the final image (step 6). Codex makes only four kinds of image: the final image; a background plate and local variants edited from the final image; and standalone assets that aren't in the final image (icons, props and sets of textures named with the slot template in section 4, looping strips that join left to right, bitmaps that are the deliverable themselves).

1. **List the pieces**: for each visible piece, write down how it moves (still, moved or turned as a whole, bending), what it meets, what covers the join, and whether it touches something drawn in code; that decides how it is taken:
   - pieces that move as a whole (a head, a torso that doesn't bend, props) and still foreground covers (a counter): cut out of the final image where they are, as PNG;
   - pieces that bend or must touch something drawn in code exactly (an arm with its sleeve, legs, a tail, wings): Codex traces them from the final image as paths, deformed with bone weights, contact points solved with IK (step 6);
   - physics, mechanics, text, UI, light effects: drawn in code.

   Put joins on the edge of something that already covers them in the final image (a strap, a collar, a cuff, a counter); keep clothing and accessories that move with a piece (sleeves, trouser hems, gloves) with that piece; leave the face and expressions on the head that moves as a whole, and do every expression as a patch (step 5), never by tracing. Before starting, tell the user in a sentence or two which pieces move as a whole, which go to Codex to be traced and bent, and which are drawn in code.
2. **Generate the final image**: the whole character or the whole scene, in the composition of the finished work. Write the prompt from the template below, deriving every line from the piece list in step 1 and phrasing it as something visible in the picture; don't put a list of pieces or how to split them in the prompt, and avoid words such as puppet, parts, joint, pivot or separate, which make the model draw a parts sheet or jointed limbs with cut faces. Go on only after the user has seen and approved it.
```text
<subject, action and composition>
Composition for animation:
- <each moving piece> is fully visible and does not overlap <the nearby pieces it must stay apart from>.      (one line per moving piece from step 1)
- <what covers each join>, e.g. the collar covers the neck, the cuff wraps the wrist, <an object in front> hides everything below the waist.
- <each moving piece> is drawn in the middle of its motion: <middle pose>.
- <moving pieces> cast no shadow on other parts; no glow, light rays or sparkles cross between objects.
- Do not draw <what code draws: steam, particles, reflections, text, UI>; leave <places for text> blank.
Style: clean anime cel shading as flat vector art (the style block in section 3), bold outline of the same weight everywhere (<outline color>).
Detail: the same level of detail everywhere: <detailed areas such as hair and clothes> drawn with a few large simple shapes, not many thin strands or fine lines. <pieces to be traced> are flat colors with exactly one hard-edged shadow tone, no gradients.
Palette: <palette>.
<background block; opaque for a whole scene>
No text, no letters, no numbers, no labels, no grid lines, no frames, no watermark.
```
3. **Generate the background plate**: pass the final image as Image 1 for an opaque edit (`transparent_background: false`) and, with the plate prompt in section 7, remove the whole subject that contains the moving pieces and fill in the background behind it, on the same canvas. The plate is only written back where the subject was, so slight changes far from the subject don't matter. Don't ask the model to take a piece out on its own, or to paint in parts of a character hidden behind something.
4. **Take the pieces**: write the piece list `pieces.json` (all coordinates are pixels of the final image) and run `assets layers --ref <final image> --plate <plate> --pieces <pieces.json> --out <dir>`:
```json
{ "pieces": [
    { "name": "counter", "kind": "raster", "lasso": [[x, y], …], "whole": true },
    { "name": "head", "kind": "raster", "lasso": [[x, y], …] },
    { "name": "body", "kind": "raster", "lasso": [[x, y], …], "extendUnder": [{ "piece": "head", "dist": 12 }] }
  ],
  "seams": [[[x, y], …]],
  "line": 20 }
```
   - `name`: letters, digits, `-` and `_` only, no duplicates, not `static`; it is also the output file name.
   - `lasso`: a polygon around the piece. The piece is what lies inside the lasso, differs from the plate, and is separated by outlines; each outline goes to the nearest piece. Lassos take pixels in list order: the side facing the background can be loose, but where it lies over another piece, draw it along this piece's edge.
   - `whole`: take every pixel inside the lasso, for still foreground covers (they are in the plate too).
   - `seams`: joins that have no outline in the final image and that Claude decides (say a chin and neck of the same color), drawn as polylines that count as outline. `line`: the brightness limit for outlines (Lab lightness, default 20); raise it when outlines have gaps and two pieces run together.
   - `extendUnder`: extend the lower piece along its flat colors `dist` pixels under the upper piece; use the most that will show as it turns. The extension only goes where the upper piece covers it.
   - `kind: "vector"`: also turn this piece into SVG, only for flat pieces with few colors. The SVG uses whole-canvas coordinates, so its position in the list is the whole canvas, with the bounding box in `box`.

   It writes `static.png` (the final image, with the subject's area replaced by the plate, color-corrected from the ring around it), a PNG or SVG per piece, `layers.json` and `layers.js` (`window.LAYERS`, each layer's place on the final image) and `check.png`. The page places pieces at the positions in `layers.js`, with no scaling or aligning; measure pivots directly in final-image coordinates.

   Check `check.png`: each piece's color covers only that piece, with the extensions lighter. Magenta boxes are regions it isn't sure of (`uncertain`); look at each: if the box holds background the plate redrew near the subject and the piece carries no extra background, it's fine; if a piece is missing a part or carries background, fix the lasso, `seams` or `line` first, and regenerate the plate per step 9 when the plate is the cause (the subject wasn't fully removed). `reassembled_diff_px` counts pixels that clearly differ from the final image after the pieces (without their extensions) are laid back over the still layer; about 1,900–2,700 in testing on a 1536×1024 picture; when it's much higher, look where.
5. **Local variants (a blink, an open mouth)**: pass the final image as Image 1 and change only that spot with the partial-edit prompt in section 7; then run `assets patch --base <final image> --variant <edited image> --out <dir>`: it puts the edited image back onto the final image (keeping the original position when the fit is uncertain), drops slight outline shifts and changes along the outer silhouette, keeps only solid areas of change, and writes a feathered `patch.png` on the final image's canvas, the combined `preview.png` and a check image. When you know which area to take, add `--keep <region>`. The patch sits on the piece it belongs to and moves with it. Don't swap whole images: in testing, swapping the whole image moved the outlines of the whole head by about a pixel besides the eyes, with more than 6,000 pixels jumping at real size; with only an eye patch, the change shrank to a few hundred pixels inside the eyes.
6. **Pieces that bend are hand-drawn by Codex**: create a plan for the draw cell (route ②, `plan --module image --cell draw --route 2 …`) and send them out with `image --plan … --seat … --scope <its output dir>`; Claude writes the brief and checks the result.
   - **What Claude prepares first**: list the pieces that bend in the piece list in step 4 too (`kind: "raster"`), and give their cut PNGs to Codex as tracing references only. Claude writes the page harness: the still layer, whole pieces, things drawn in code, the draw order, the `?t=` / `?rest` / `?capture` parameters, and the angle of every joint at every moment, worked out from the motion formulas. It leaves one empty interface for Codex to implement, such as `buildRig({ <a <g> per layer> }) → { arm(aU, aF, aH), tail(t, amp) }`. The pivots go in a file of their own, in final-image coordinates.
   - **What the brief says**:
     - scope: only its own rig file and work folder;
     - where the inputs are;
     - the interface and what each angle means (all 0 is the final image's pose);
     - the pieces must be `<path>` elements traced from the final image: no embedded PNGs, no `<image>`, filters or masks;
     - the rest pose matches the final image: outlines, line weight, base colors and shadows;
     - what the joins must do: the end by a cover doesn't move, no background shows at a join, and the line weight doesn't jump;
     - native SVG and plain JavaScript only;
     - the commands it may use: `assets trace`, `capture` and `playback`;
     - what to self-check: capture `?rest` and both ends of every motion, look at 2x close-ups of each join, run one loop of playback;
     - what to report: the seeds and parameters it used, how the weights are set, and what's left.
   - **How it's done** (put this in the brief, or have it read this step):
     - Tracing: `assets trace --image <final image> --seed <a point in the piece's fill> --box <a rectangle around the piece> --out <dir>` fills out the piece from the seed, splits it into outline, base color and shadow (`--colors` sets the number of fill tones), and writes `trace.svg` in final-image coordinates (one `<path>` per layer, curved outlines, fine inner lines as holes in the fill) and a check image. For a piece with several colors, put a seed in each color. The traced line weight and colors share their source with the cut pieces, so nothing needs converting.
     - Deformation: both sides of a joint share one weight field, and the end at the join is pinned to the piece that doesn't move (a fixed end such as a tail base gets a pinned band that eases into the bend). Subdivide long curves before deforming, so a curve's control handles never span a joint and get pulled into a spike.
     - Drawing: draw all the outlines first and then all the fills, so the fills cover the inner outlines at the joints. The end that meets a whole piece goes under it.
   - **Claude checks it itself and doesn't rely on the agent's self-check**:
     - read the diff: only its own files may change, and check nothing was written outside the workspace;
     - capture `?rest` and compare it with the final image over the pieces' area: both hand-drawn versions in the trial averaged an RGB difference of about 4, against 0.3 for the cut PNGs laid on directly;
     - look at 2x close-ups of every join at both ends of the motion;
     - run `assets playback`: flicker, loop seam and jumps must all be 0;
     - finally, watch it play.
     - If it isn't right, rework it once with `resume --reason rework` (no `--level`) under "Rework" in `references/acceptance.md`, saying exactly what's wrong; if it still isn't right, Claude takes over.
7. **SVG or not**: turn flat assets with few colors into SVG with `assets cut --vector`; ask for a flat style with little shading when generating, and for detailed assets with many colors add `--colors 8` to `12` when vectorizing, which cuts the path count to a quarter or less (flat icons barely change); use `--palette … --snap` to fix the colors. Keep characters and images with gradients or much detail as PNG, embedded with `<image>` in the SVG or page: without color reduction an anime character part has tens to five hundred paths, which stutters on a web page, and reducing colors leaves bands. That's how routes ① and ② work; when the user chose route ③ or ④ the result must be paths only, so it can't be delivered this way.
8. **Assemble and check**: the page must support `?t=<seconds>` to stop at a given moment (screenshots and checks depend on it). After assembling, use `assets capture --url <page> --times <seconds,…> --size <display size> --zoom <name=rectangle at a join;…> --out <dir>` to take a few key moments at the real display size (both ends of a motion, when something passes in front of something else, when a variant shows) with 2x close-ups, and look at the joins, anything that looks detached, and the line weight. For an animation, also capture one loop with `assets playback --url <page> --loop <seconds per loop> --static <regions that should not move;…> --out <dir>`: a change inside a `static` region is flicker, a non-zero `seam` means the loop doesn't join, and `jumps` lists moments that suddenly jump; give the user `playback.png` (an APNG that plays in a browser) to watch. Screenshots need the local Chrome or Edge; if neither is found, point to one with `--browser`. Before delivering an animation, it's best to have a model that didn't make it do a visual check too: `review --target visual --file <screenshots or playback.png> …`, with a review brief that says what to look at (joins, flicker, the loop seam, line weight); only agents that can read images can take it (Codex for now).
9. **Thresholds for regenerating**: if any of these holds, regenerate that image with a different approach instead of patching it up later.
   - Final image: a moving piece is covered by another with no outline or cover between them, or a join isn't on the edge of a cover. Change the prompt and regenerate; the user approves it again.
   - Plate: in `layers.json`, `plate.measured` (the measured alignment, whether or not the plate was then used in place, and whatever `ambiguous` says) has an `offset` above 3 pixels or a `scale` off 1 by more than 1%, meaning the whole picture was moved or redrawn (good plates measured 0.1–0.7 pixels off and less than 0.1% scaled in testing); `plate.noise` (the typical color difference between plate and final image outside the subject, 1.4–1.6 in testing) is above 3; or traces of the subject still show in `static.png`. Name what was left behind in the new prompt.
   - Local variant: in `patch.json`, `align.measured` has an `offset` above 3 pixels or a `scale` off 1 by more than 1% (good edits measured 0.6–0.8 pixels off in testing); or the patch `box` clearly reaches beyond the spot to change. Describe a narrower change in the new prompt.
   - Once things move: a join drifting apart by more than about 3 pixels in a 2x close-up, or a sudden change of line weight, is not an image problem. The pieces share a source and line up to begin with, so fix the deformation code (pivots, weights, positions); don't enlarge hand-drawn parts to cover it. Deformation Codex wrote goes back for rework as in step 6.
   - When a built-in command reports it isn't sure, follow the points above; don't write a registration or fitting script to get around it. If three regenerations in a row don't improve the same problem, stop and let the user decide (the rework rule in point 13 of `references/image.md`).
10. **Why it's split this way** (October 2026 trials):
   - Having the model draw jointed parts sheets, frames from a pose guide, or two halves in two generations: joint pivots, contact with things drawn in code and the seam between halves could not line up, often off by a sizable fraction of the piece length; in the frame trial, 6 of 8 frames missed the contact point.
   - Taking single pieces out of the reference on a transparent background: heads came back enlarged 1.86–2.06 times and bodies 1.4–1.59 times, some with redrawn proportions and colors; `align` leaned toward shrinking large flat pieces and gave no result it was sure of; asked to "remove the arm" or "remove the sleeve and finish the edge", the model didn't in all 4 tries, redrawing the cuff as an opening with an inner rim about 50 pixels lower.
   - Opaque edits of the whole canvas keep their place: 99.6% of the plate far from the subject stayed unchanged; a counter generated as its own layer was off by about 15 pixels, while the one cut from the plate matched pixel for pixel.
   - The same-source trial: only a plate and a closed-eye edit were generated; the head, body and counter matched the final image pixel for pixel, cut and traced outlines were both 3 pixels, and playback showed no flicker and a loop seam of 0.
   - The hand-drawing comparison: from the same inputs, page harness and motion formulas, Codex (gpt-6.1-sol, effort max) and Claude each hand-drew the waving arm with its sleeve and the tail on their own. The metrics tied: an average rest-pose difference of 4.07 against 4.03, no background showing at the joins for either, and playback checks all 0 for both. In the blind review the user found Codex's version more natural. It did a few things more: it subdivided curves before deforming, used a diagonal blend at the elbow and a pinned band at the tail base, and used gradients for the skin. It took 26 minutes and more tokens. In its first round it wrote Chinese paths percent-encoded and ended up writing outside the workspace, so check for that when reviewing.
   - The final-image template: much less hair detail and fewer gradients, the tail tip to be traced turned from gradient fluff into flat color, and the detail gap between generated and traced parts shrank by about 60%.

## 7. Edits and layers
- **A partial change**: the original as Image 1, and "Change ONLY <target and position>: <change>. Keep every other part exactly unchanged: same parts, same positions, same sizes, same colors, same line art, and the same background." An edit slightly changes other areas too (an average color difference of 2–3 in testing); check with `assets diff --before <original> --after <new> --slots <template>` that only the target slot changed, and when delivering replace only that part.
- **The background plate**: the final image as Image 1, `transparent_background: false`, and "Remove <subject> completely and fill that area with the background that would be behind them … Change nothing else: same canvas size, same composition and framing". Say whether the subject's shadow on the ground stays or goes: if it stays, it's part of the still layer; if it goes, take it as a piece. Don't take a subject layer by asking the model, on a transparent background, to "keep only the subject": it comes back enlarged and redrawn (step 10 of section 6).
- **Removing the background from an existing image**: the original as Image 1, "Remove only the background and make it fully transparent. Keep <subject> exactly as they are … Do not redraw or restyle anything."
- Changes build up over several rounds of edits to the same image; after two or three, regenerate from the source.

## 9. What it can't do or hasn't been verified
- Pixel art, exact pixel sizes, and high-resolution images above about 1.57 megapixels.
- Having the model draw jointed parts, single pieces or frame-by-frame motion: see section 6; testing showed they don't line up.
- Big turns or changes of viewpoint: they need a side the final image doesn't show, which taking pieces from one image can't give.
- The plate and local variants are put onto the final image by uniform scale and shift only, not rotation; if the model turned them, they won't line up and have to be regenerated.
- `assets layers` tells the subject from the plate by how they differ: where the subject has the same color as the background behind it and no outline between them, it can't separate them, so draw the join with `seams`. The stretch extended under a join only spreads the flat colors, so it looks flat when much of it shows; keep the turn within the `extendUnder` distance. This stretch has been checked in two trials only.
- Pieces carry no layer or draw order; that's set in code: neither the `assets cut` manifest nor the `assets layers` layers.json has it.
- Semi-transparent assets (glass, smoke) only get the rough `--matte soft` treatment and haven't been tested systematically.
- On detailed character parts the built-in tracer breaks 1-pixel lines (hair strands) into a row of dots and makes many paths: one more reason characters stay PNG.
- How the layered SVG behaves after import into Figma or Illustrator (groups, editability) hasn't been checked in practice.
