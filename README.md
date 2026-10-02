# Kims · 3D store tour

A static site: the photogrammetry mesh of the store, with each of the 25 source photos pinned to the camera pose it was taken from.

## Run locally

ES modules and `fetch` don't work from `file://`, so serve the folder:

```bash
cd website
python3 -m http.server 8000
# open http://localhost:8000
```

No build step. three.js (r169) and the fonts load from CDNs (jsDelivr, Google Fonts).

## Layout

```
index.html            page shell: welcome card, retro loader, shot bar
css/style.css         light/dark tokens, grid background, UI
js/main.js            three.js scene, tour/overview modes, flights, photo overlay
assets/kims.glb       web-optimized mesh (8 MB; from type_glb/kims_model_but_fixed_axes.glb)
assets/cameras.json   25 shot poses in the scene frame + intrinsics
assets/photos/*.jpg   undistorted photos, 1500x2000
assets/thumbs/*.jpg   thumbnails for the overview tooltip
tools/build_assets.py regenerates cameras.json, photos/ and thumbs/
```

## Where the camera data comes from

`../kims_cams.xml` is the Agisoft Metashape camera export (25 aligned cameras, shared calibrated sensor:
f = 2926.19 px, 3000x4000, k1–k3/p1–p2). The poses are in the frame of the original `kims_3d.glb`.
`kims_model_but_fixed_axes.glb` is that mesh rotated by `(x, y, z) → (x, z, −y)`, so the build script
applies the same rotation to the poses. The site then rotates the whole scene so the cameras' mean
"up" points to +Y.

Each photo is undistorted with the calibrated lens model and recentred on the principal point.
With an ideal pinhole camera, a plane at depth *d* sized `2·d·tan(fov/2)` lines up exactly with the mesh
behind it.

Check: projecting the mesh's vertex colours through every pose and comparing against the photos gives a
mean correlation of 0.75 across all 25 shots (a mis-aligned frame scores ≈ 0).

## Rebuilding assets

```bash
# poses + photos (needs python3, numpy, opencv-python)
python3 website/tools/build_assets.py

# mesh: 8192² JPEG texture → 4096² WebP, meshopt-compressed geometry (no simplification)
npx @gltf-transform/cli optimize type_glb/kims_model_but_fixed_axes.glb website/assets/kims.glb \
  --compress meshopt --texture-compress webp --texture-size 4096 --simplify false
```

Both commands run from the `CV/` root.

## Controls

| | |
|---|---|
| ← / → , swipe | previous / next shot |
| Esc | leave the shot, back to overview |
| C | Compare: fade the photo to 45 % to check the fit against the mesh |
| Drag / scroll (overview) | orbit / zoom; click or tap a camera to step into its photo |

## Hosting notes

- Any static host works (GitHub Pages, Netlify, Cloudflare Pages, S3).
- Serve `.glb` as `model/gltf-binary`. Most hosts already do.
- If the host gzips on the fly and drops `Content-Length`, the loader switches to an estimated progress curve.
