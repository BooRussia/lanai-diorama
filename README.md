# Pria Ghuman · Lanai Diorama

An interactive 3D "cake slice" diorama of an arched steel-and-glass loggia with an outdoor kitchen, floating on its own little island in the sky. Built with [three.js](https://threejs.org/) r128 as a single HTML page, with every texture generated in code.

## Features

- Gold title set into the sky, with clouds drifting in front and sunlight sliding across the metal; a **The design** sheet (side panel on desktop, swipeable bottom sheet on phones) explains how the steel-and-glass openings replace the screened lanai
- Arched steel-and-glass French doors and casements, hip roofs, a two-story tower and a herringbone-tile wing
- A round slice of land torn out of the earth: lawn, shrubs and a paved terrace with a pool, with soil and rock layers exposed on the torn edge
- A floating rock island with dangling roots and vines, plus small islets drifting below
- A 24-hour sky with gradient sunrises and sunsets, a moon, thousands of twinkling stars and a Milky Way, all rotating around the island
- A sun dial: drag it around the clock and the sky swings past and rubber-bands back into place
- Click the dial's center to dissolve the roof into glowing embers (and click again to bring it back)
- Reflective Fresnel glass, a mirrored pool surface, caustics on the pool floor, contact shadows and glowing lights at night
- Walk mode: press W A S D (or the footprints button) to fly down onto the lawn and walk the courtyard and loggia at eye height. Mouse to look (click to capture the mouse, Esc to release it, Esc again to leave), Shift to run, arrow keys to walk and turn. Walls, glass, furniture, the pool and the island's edge stop you, and the French doors open as you walk up to them
- Works on phones: one finger to orbit, pinch to zoom, two fingers to pan, double-tap to reset the view. In walk mode a joystick appears under your left thumb (walk and turn, push past the ring to jog), the right thumb looks around, and the other controls step aside until you tap the footprints to leave

## Run it

Open `index.html` in a modern browser. It loads three.js from cdnjs and OrbitControls from jsDelivr, so it needs an internet connection.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page (loads the realism modules from `modules/`) |
| `src/sky.js` | Sky dome, sun and moon, stars, clouds and the floating island (also inlined in `index.html`) |
| `modules/materials_ext.js` | Exterior materials: stucco, steel frames, glass, shingles, pavers, pool, herringbone, garden |
| `modules/materials_int.js` | Interior materials: floor tile, fabrics, rattan, teak, rugs, brushed stainless, granite |
| `modules/lighting.js` | Soffit can lights, interior glow, sun/sky balance, shadows, pool light |
| `modules/post.js` | Post-processing: MSAA, ambient occlusion, bloom, filmic grade |
| `src/textures.js` | Procedural textures: stucco, tile, pavers, shingles, soil section, pool mosaic and more (also inlined in `index.html`) |
