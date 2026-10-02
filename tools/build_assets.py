"""
Build the web assets for the Kims store tour.

Inputs (relative to the CV/ root):
  kims_cams.xml                               Metashape camera export (poses + calibration)
  PROJ/dataset/<label>.jpg                    the original 3000x4000 photos
  type_glb/kims_model_but_fixed_axes.glb      the mesh (compressed separately, see README)

Outputs (website/assets/):
  cameras.json     per-shot pose in the web scene frame + intrinsics
  photos/<n>.jpg   undistorted, recentred photos (ideal pinhole, principal point at centre)
  thumbs/<n>.jpg   small thumbnails for the shot strip

Frames
  Metashape camera:  x right, y down, z forward; <transform> is camera -> chunk (no chunk
                     transform is present, so chunk == the original kims_3d.glb frame).
  fixed-axes GLB:    original rotated by (x, y, z) -> (x, z, -y)   [matrix M below]
  web scene:         fixed-axes frame rotated by A so the cameras' mean "up" becomes +Y.
                     The page applies A to the GLB root, so poses here are final.
  three.js camera:   x right, y up, z backward  ->  basis = R_world @ diag(1, -1, -1)
"""
import json
import os
import xml.etree.ElementTree as ET

import cv2
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "website", "assets")
XML = os.path.join(ROOT, "kims_cams.xml")
DATASET = os.path.join(ROOT, "PROJ", "dataset")

WEB_HEIGHT = 2000  # photo height on the web (width follows the 3:4 aspect)
THUMB_HEIGHT = 320

M = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], float)


def rotation_between(a, b):
    """Smallest rotation taking unit vector a onto unit vector b."""
    a, b = a / np.linalg.norm(a), b / np.linalg.norm(b)
    v, c = np.cross(a, b), float(np.dot(a, b))
    if np.linalg.norm(v) < 1e-12:
        return np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * (1 / (1 + c))


def main():
    root = ET.parse(XML).getroot()
    sensor = root.find(".//sensor")
    res = sensor.find("resolution")
    W, H = int(res.get("width")), int(res.get("height"))
    cal = sensor.find("calibration")
    g = lambda k: float(cal.find(k).text) if cal.find(k) is not None else 0.0
    f, cx, cy = g("f"), g("cx"), g("cy")
    k1, k2, k3, p1, p2 = g("k1"), g("k2"), g("k3"), g("p1"), g("p2")

    # Metashape's p1/p2 are swapped relative to OpenCV's tangential terms.
    K = np.array([[f, 0, W / 2 + cx - 0.5], [0, f, H / 2 + cy - 0.5], [0, 0, 1]])
    dist = np.array([k1, k2, p2, p1, k3])
    K_new = np.array([[f, 0, (W - 1) / 2], [0, f, (H - 1) / 2], [0, 0, 1]])
    map1, map2 = cv2.initUndistortRectifyMap(K, dist, None, K_new, (W, H), cv2.CV_32FC1)

    cams = []
    for cam in root.iter("camera"):
        if cam.find("transform") is None:
            continue  # unaligned camera
        T = np.array(list(map(float, cam.find("transform").text.split()))).reshape(4, 4)
        cams.append((cam.get("label"), M @ T[:3, :3], M @ T[:3, 3]))
    cams.sort(key=lambda c: int(c[0]))

    mean_up = np.mean([-R[:, 1] for _, R, _ in cams], axis=0)
    A = rotation_between(mean_up, np.array([0.0, 1.0, 0.0]))

    os.makedirs(os.path.join(OUT, "photos"), exist_ok=True)
    os.makedirs(os.path.join(OUT, "thumbs"), exist_ok=True)
    web_w = round(WEB_HEIGHT * W / H)
    thumb_w = round(THUMB_HEIGHT * W / H)

    shots = []
    for label, R, t in cams:
        Rw = A @ R @ np.diag([1, -1, -1])
        shots.append({
            "id": label,
            "position": (A @ t).round(6).tolist(),
            # three.js camera basis vectors (world space): x right, y up, z backward
            "basis": [Rw[:, 0].round(6).tolist(), Rw[:, 1].round(6).tolist(), Rw[:, 2].round(6).tolist()],
            "photo": f"assets/photos/{label}.jpg",
            "thumb": f"assets/thumbs/{label}.jpg",
        })
        img = cv2.imread(os.path.join(DATASET, f"{label}.jpg"), cv2.IMREAD_COLOR | cv2.IMREAD_IGNORE_ORIENTATION)
        assert img.shape[:2] == (H, W), (label, img.shape)
        und = cv2.remap(img, map1, map2, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        web = cv2.resize(und, (web_w, WEB_HEIGHT), interpolation=cv2.INTER_AREA)
        cv2.imwrite(os.path.join(OUT, "photos", f"{label}.jpg"), web, [cv2.IMWRITE_JPEG_QUALITY, 82, cv2.IMWRITE_JPEG_PROGRESSIVE, 1])
        thumb = cv2.resize(und, (thumb_w, THUMB_HEIGHT), interpolation=cv2.INTER_AREA)
        cv2.imwrite(os.path.join(OUT, "thumbs", f"{label}.jpg"), thumb, [cv2.IMWRITE_JPEG_QUALITY, 75])
        print("wrote", label)

    out = {
        "source": "kims_cams.xml (Agisoft Metashape 2.2)",
        "image": {"width": W, "height": H},
        # half-angle tangents of the undistorted pinhole photo
        "tanHalfFov": {"x": (W / 2) / f, "y": (H / 2) / f},
        # rotation applied to the GLB root so the scene is Y-up (row-major 3x3)
        "sceneRotation": A.round(9).flatten().tolist(),
        "shots": shots,
    }
    with open(os.path.join(OUT, "cameras.json"), "w") as fh:
        json.dump(out, fh, indent=1)
    print("cameras.json:", len(shots), "shots")


if __name__ == "__main__":
    main()
