# Kims · 3D store tour

A neighbourhood store rebuilt in 3D from 25 phone photos, with each photo pinned back to the exact spot it was taken from.

### [▶ Open the live tour](https://kims-store.pages.dev)

Use the arrows to walk the store left to right, unlock the camera to look around (drag or phone gyro),
switch to Overview to orbit the whole model, or flip between the textured mesh and the dense point cloud.

## Run locally

ES modules and `fetch` don't work from `file://`, so serve the folder:

```bash
cd website
python3 -m http.server 8000
# open http://localhost:8000
```

No build step. three.js (r169) and the fonts load from CDNs (jsDelivr, Google Fonts).
Gyro look-around needs HTTPS, so test it on the live site rather than on a local `http://` address.

## Layout

```
index.html                  page shell: welcome card, retro loader, shot bar, look-around menu, help boxes
css/style.css               light/dark tokens, grid background, UI
js/main.js                  three.js scene, tour/overview modes, flights, photo overlay,
                            look-around (drag + gyro), mesh / point cloud switch, help overlay
assets/kims.glb             web-optimized mesh (8 MB; from type_glb/kims_model_but_fixed_axes.glb)
assets/points.glb           dense point cloud, 1.34M points (9 MB)
assets/points-preview.glb   coarse point cloud shown while the full one loads (2 MB)
assets/cameras.json         25 shot poses in the scene frame + intrinsics
assets/photos/*.jpg         undistorted photos, 1500x2000
assets/thumbs/*.jpg         thumbnails for the overview tooltip
tools/build_assets.py       regenerates cameras.json, photos/ and thumbs/
tools/build_pointcloud.py   regenerates points.glb and points-preview.glb from the Metashape dense cloud
```

## Where the camera data comes from

`../kims_cams.xml` is the Agisoft Metashape camera export (25 aligned cameras, shared calibrated sensor:
f = 2926.19 px, 3000x4000, k1-k3 / p1-p2). The poses are in the frame of the original `kims_3d.glb`.
`kims_model_but_fixed_axes.glb` is that mesh rotated by `(x, y, z) → (x, z, −y)`, so the build script
applies the same rotation to the poses. The site then rotates the whole scene so the cameras' mean
"up" points to +Y.

Each photo is undistorted with the calibrated lens model and recentred on the principal point.
With an ideal pinhole camera, a plane at depth *d* sized `2·d·tan(fov/2)` lines up exactly with the mesh
behind it.

Check: projecting the mesh's vertex colours through every pose and comparing against the photos gives a
mean correlation of 0.75 across all 25 shots (a mis-aligned frame scores ≈ 0).

## The point cloud

The point cloud is Metashape's dense cloud (`type_meta/kims_meta.files/0/0/dense_cloud/dense_cloud.oc3`,
57.8M valid points, 793 MB). The `.oc3` format has no public spec; `tools/build_pointcloud.py` reads it
directly (the layout is documented in the script's header), so Metashape isn't needed to rebuild it.

- Points removed while cleaning the cloud in Metashape are flagged in the file and are left out.
- The rest are thinned to one point per ~3 cm, rotated into the site's frame and meshopt-compressed.
- It's in the same frame as the cameras, so the photos line up with it as they do with the mesh
  (colour correlation 0.81-0.83 against the photos).
- Colours are stored as sRGB, while glTF treats vertex colours as linear, so the shader decodes them
  (sRGB → linear) to avoid a washed-out look.

On the site, the first switch to Points keeps the mesh up while the retro loader shows progress, then
crossfades without moving the camera. The cloud also prefetches once the visitor is idle (skipped on
data saver or 2G connections).

## Rebuilding assets

```bash
# poses + photos (needs python3, numpy, opencv-python)
python3 website/tools/build_assets.py

# point cloud (needs python3, numpy, and npx for gltf-transform)
python3 website/tools/build_pointcloud.py

# mesh: 8192² JPEG texture → 4096² WebP, meshopt-compressed geometry (no simplification)
npx @gltf-transform/cli optimize type_glb/kims_model_but_fixed_axes.glb website/assets/kims.glb \
  --compress meshopt --texture-compress webp --texture-size 4096 --simplify false
```

All commands run from the `CV/` root.

## Controls

| | |
|---|---|
| ← / → , swipe | previous / next shot (no wrap-around at either end) |
| L | unlock / lock the camera at a shot to look around (drag or gyro) |
| C | Compare: fade the photo to 45 % to check the fit against the model |
| P | switch between mesh and point cloud |
| H or ? | show / hide the help boxes that explain every control |
| Esc | leave the shot, back to overview |
| Drag / scroll (overview) | orbit / zoom; click or tap a camera to step into its photo |

Gliding the mouse over the Mesh / Points switch, or long-pressing it on a phone, slides out its full
labels (a long-press only reveals them; it doesn't switch modes). The help boxes are grouped per set of
controls (view switch, side column, bottom bar), follow what is on screen, and never block the page.

While the camera is unlocked in Drag mode, swiping looks around instead of changing shots; the arrow
buttons still navigate. Gyro mode asks for motion permission on iPhone and falls back to Drag when
no sensor is available.

## Hosting

Deployed on Cloudflare Pages from this repo: every push to `main` redeploys
[kims-store.pages.dev](https://kims-store.pages.dev). There is no build step (framework preset: None,
output directory: `/`).

- Serve `.glb` as `model/gltf-binary`. Most hosts already do.
- If the host gzips on the fly and drops `Content-Length`, the loaders switch to an estimated progress curve.
