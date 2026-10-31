# BioLens: AR 3D Room Hide & Seek

A real-time multiplayer Augmented Reality (AR) game where players scan their physical room, find 15 hidden 3D animals on the floor, pick them up using hand tracking or touch, and carry them to a corner rescue basket.

🎥 **Gameplay Demo Video:** [Watch on iCloud](https://www.icloud.com/photos/#/icloudlinks/036gTOzETdT2J835nwObXrAfg/)

---

## How It Works

1. **Join with Name:** Enter your name to join the shared room session (no sign-up required).
2. **Host Room Scan:** The host scans the room until **90%** of the floor mesh turns green and real-world furniture/objects are mapped.
3. **Find & Rescue:** Once scanned, a **3-second countdown** starts a **2-minute match**. **15 3D animals** hide around the room floor.
4. **Grab & Drop in Corner Basket:** Reach out with your hand (pinch/grab gesture) or tap to pick up an animal, walk to the **Corner Rescue Basket**, and release it inside.
5. **Win Condition:** The first player to collect **5 animals** in the basket wins!

---

## Tech Stack

- **Frontend:** React 19, TypeScript, Tailwind CSS, Vite
- **3D & Spatial AR:** Three.js (6DoF spatial floor mesh, procedural 3D animals, ground-plane physics)
- **Computer Vision:** MediaPipe Hand Landmarker (3D hand tracking & grab gestures), TensorFlow.js (`COCO-SSD` real-time object detection)
- **Multiplayer Backend:** Node.js, Express, Server-Sent Events (SSE) for real-time room state sync

---

## Quick Start

```bash
# Install dependencies
npm install

# Start development server (Frontend + Multiplayer Backend on port 3000)
npm run dev
```
