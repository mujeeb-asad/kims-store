"""
Build web point clouds from the Metashape dense cloud (.oc3), without Metashape.

Input (relative to the CV/ root):
  type_meta/kims_meta.files/0/0/dense_cloud/dense_cloud.oc3   57.8M valid points, 793 MB
  website/assets/cameras.json                                  for the scene rotation

Outputs (website/assets/):
  points.glb          evenly thinned cloud (glTF POINTS, quantized + meshopt)
  points-preview.glb  coarser version that can show while points.glb loads

The .oc3 layout was worked out from the file itself (no public spec):
  - 512-byte header listing 10 per-point channels, 1 byte each:
      POSX POSY POSZ  NRMX NRMY NRMZ  CLRR CLRG CLRB  CLAS
  - NODE blocks: "NODE", u32 0, u64 count, then count bytes per channel (channel-major).
    Positions are bytes within the block's octree cell: (b + 0.5) / 256 * cell size.
  - Tail records:
      bounding cube: origin at +0x40, size at +0x58 (3 doubles each)
      TREE: one child mask per cell, depth-first; bit i -> child (i&1, i>>1&1, i>>2&1)
      OFFS: file offset of each cell's NODE block, in the same depth-first order
  - Leaves (depth 9) hold the full cloud; shallower levels are level-of-detail copies.
  - CLAS 128 marks points deleted while cleaning the cloud (matches validCount exactly).
Checked by projecting the decoded colours through kims_cams.xml: correlation 0.81-0.83
with the photos.
"""
import json
import os
import struct
import subprocess
import sys

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OC3 = os.path.join(ROOT, "type_meta", "kims_meta.files", "0", "0", "dense_cloud", "dense_cloud.oc3")
CAMERAS = os.path.join(ROOT, "website", "assets", "cameras.json")
OUT = os.path.join(ROOT, "website", "assets")

DELETED = 128
LEVELS = {"points.glb": 0.03, "points-preview.glb": 0.07}   # voxel size in model units
BATCH = 3_000_000                                            # points decoded per batch (memory bound)

# original Metashape frame -> fixed-axes GLB frame (same as build_assets.py)
M = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], float)


def read_oc3(path):
    raw = np.memmap(path, dtype=np.uint8, mode="r")
    off, blocks = 512, {}
    while bytes(raw[off:off + 4]) == b"NODE":
        count = int(np.frombuffer(raw[off + 8:off + 16].tobytes(), "<u8")[0])
        blocks[off] = count
        off += 16 + count * 10
    tail = raw[off:].tobytes()
    origin = np.array(struct.unpack("<3d", tail[0x40:0x58]))
    size = np.array(struct.unpack("<3d", tail[0x58:0x70]))
    t = tail.index(b"TREE")
    n = struct.unpack("<Q", tail[t + 16:t + 24])[0]
    masks = np.frombuffer(tail[t + 40:t + 40 + n], np.uint8)
    o = tail.index(b"OFFS")
    offs = np.frombuffer(tail[o + 40:o + 40 + n * 8], "<u8")
    return raw, blocks, origin, size, masks, offs


def leaf_cells(masks, offs, blocks):
    """Yield (block offset, count, depth, ix, iy, iz) for every cell, depth-first."""
    stack, k = [(0, 0, 0, 0)], 0
    while stack:
        d, ix, iy, iz = stack.pop()
        m = int(masks[k]); off = int(offs[k]); k += 1
        yield off, blocks[off], d, ix, iy, iz
        for b in reversed(range(8)):
            if m >> b & 1:
                stack.append((d + 1, ix * 2 + (b & 1), iy * 2 + (b >> 1 & 1), iz * 2 + (b >> 2 & 1)))


def thin(raw, cells, origin, size, voxel):
    """Valid leaf points, one per voxel, streamed in batches."""
    kept_keys, kept_p, kept_c = [], [], []
    buf_p, buf_c, n = [], [], 0

    def flush():
        nonlocal buf_p, buf_c, n
        if not buf_p:
            return
        p = np.concatenate(buf_p); c = np.concatenate(buf_c)
        key = np.floor(p / voxel).astype(np.int64) @ np.array([1, 1 << 21, 1 << 42], np.int64)
        _, first = np.unique(key, return_index=True)
        kept_keys.append(key[first]); kept_p.append(p[first]); kept_c.append(c[first])
        buf_p, buf_c, n = [], [], 0

    for off, count, d, ix, iy, iz in cells:
        if d != 9 or count == 0:
            continue
        blk = raw[off + 16:off + 16 + count * 10].reshape(10, count)
        ok = blk[9] != DELETED
        cell = size / 512.0
        xyz = (blk[:3, ok].T.astype(np.float64) + 0.5) / 256.0
        buf_p.append(origin + (np.array([ix, iy, iz]) + xyz) * cell)
        buf_c.append(blk[6:9, ok].T.copy())
        n += int(ok.sum())
        if n >= BATCH:
            flush()
    flush()
    key = np.concatenate(kept_keys)
    _, first = np.unique(key, return_index=True)   # voxels split across batches
    return np.concatenate(kept_p)[first], np.concatenate(kept_c)[first]


def write_glb(path, positions, colors):
    pos = positions.astype("<f4").tobytes()
    col = colors.astype(np.uint8).tobytes()
    pad = (-len(col)) % 4
    bin_ = pos + col + b"\0" * pad
    gltf = {
        "asset": {"version": "2.0", "generator": "kims build_pointcloud.py"},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "name": "dense_cloud"}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "COLOR_0": 1}, "mode": 0}]}],
        "buffers": [{"byteLength": len(bin_)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": len(pos)},
            {"buffer": 0, "byteOffset": len(pos), "byteLength": len(col)},
        ],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(positions), "type": "VEC3",
             "min": positions.min(0).tolist(), "max": positions.max(0).tolist()},
            {"bufferView": 1, "componentType": 5121, "normalized": True, "count": len(colors), "type": "VEC3"},
        ],
    }
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * ((-len(js)) % 4)
    with open(path, "wb") as fh:
        fh.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(bin_)))
        fh.write(struct.pack("<II", len(js), 0x4E4F534A)); fh.write(js)
        fh.write(struct.pack("<II", len(bin_), 0x004E4942)); fh.write(bin_)


def main():
    raw, blocks, origin, size, masks, offs = read_oc3(OC3)
    with open(CAMERAS) as fh:
        A = np.array(json.load(fh)["sceneRotation"]).reshape(3, 3)
    R = A @ M   # Metashape frame -> web scene frame, so the site needs no extra transform

    for name, voxel in LEVELS.items():
        p, c = thin(raw, leaf_cells(masks, offs, blocks), origin, size, voxel)
        p = p @ R.T
        tmp = os.path.join(OUT, name + ".raw.glb")
        write_glb(tmp, p, c)
        dst = os.path.join(OUT, name)
        # quantize positions + meshopt-compress, same toolchain as the mesh
        subprocess.run(["npx", "-y", "@gltf-transform/cli", "meshopt", tmp, dst], check=True,
                       stdout=subprocess.DEVNULL)
        os.remove(tmp)
        print(f"{name}: {len(p):,} points, {os.path.getsize(dst) / 1e6:.1f} MB")


if __name__ == "__main__":
    sys.exit(main())
