// build-particle-showcase — generate a batch of particles concepts
// end-to-end. For each: Nano Banana atlas, preset JSON, catalog
// entry (hand-seeded annotation as fallback), capture + Gemini
// annotate + R2 upload via the existing annotate command.
//
// Each concept is defined inline as data so future runs only have
// to re-run a missing concept (atlases are cached on disk).

import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { GoogleGenAI } from "@google/genai";

import { runAnnotateOne } from "./annotate";

const ATLAS_TILES_PER_ROW = 4;
const TILE_SIZE = 512;
const ATLAS_SIZE = ATLAS_TILES_PER_ROW * TILE_SIZE;
const MODEL_IMAGE = "gemini-3.1-flash-image-preview";

interface ConceptPreset {
  particle_size?: number;
  size_variance?: number;
  velocity_stretch?: number;
  curl_scale?: number;
  velocity_damp?: number;
  audio_gain?: number;
  volume_size?: [number, number, number];
  wave_amplitude?: number;
  flow_drift_x?: number;
  corona_boost?: number;
  dance_amount?: number;
  camera_radius?: number;
  camera_height?: number;
  camera_orbit_speed?: number;
  fov_degrees?: number;
  trail_decay?: number;
  flock_separation?: number;
  flock_alignment?: number;
  flock_cohesion?: number;
  flock_radius?: number;
}

interface ConceptDef {
  id: string;
  display_name: string;
  blurb: string;
  atlas_prompt: string;
  preset: ConceptPreset;
  vibe: string[];
  motion: number;
  palette_anchor: string[];
  audio_affinity: { bass: number; mid: number; treble: number };
  techniques: string[];
  technical_notes: string;
}

// Each concept is one Refik-style image-particle showcase. The atlas
// is what makes the look; preset values are tuned so the same backend
// reads as the intended reference. All hand-seeded annotations get
// overwritten by Gemini after capture but provide a viable fallback
// if Gemini 503s and we still want the entry in the gallery.
const CONCEPTS: ConceptDef[] = [
  {
    id: "cherry-blossom-storm",
    display_name: "Cherry Blossom Storm",
    blurb: "A swirling current of cherry blossom petals carried on a slow spring wind, sky gradient overhead, camera drifting through the storm at eye level.",
    atlas_prompt:
      "soft pink cherry blossom petals (sakura), various angles and stages of fall — some fully open, some curled, some with white centers — varied warm-pink hues, each tile a single petal centered on a soft dark blue-black background, photographed with shallow depth of field",
    preset: {
      particle_size: 0.045,
      size_variance: 0.95,
      velocity_stretch: 1.2,
      curl_scale: 0.6,
      velocity_damp: 0.99,
      audio_gain: 0.7,
      volume_size: [5.0, 0.8, 5.0],
      wave_amplitude: 0.25,
      flow_drift_x: 1.0,
      corona_boost: 1.2,
      dance_amount: 0.3,
      camera_radius: 5.5,
      camera_height: 0.4,
      camera_orbit_speed: 0.02,
      fov_degrees: 55,
    },
    vibe: ["romantic", "contemplative", "atmospheric", "spring", "painterly"],
    motion: 0.5,
    palette_anchor: ["#1a0e1c", "#3a1c2c", "#d6a8b8", "#f4d4dc"],
    audio_affinity: { bass: 0.3, mid: 0.4, treble: 0.2 },
    techniques: ["instanced_particles", "wave_attractor", "crossed_billboards", "image_atlas_sampling"],
    technical_notes:
      "65,536 cherry blossom particles drift through a wide curl-noise flow field with strong horizontal current, simulating a slow spring wind through a hanami garden. The wave attractor is shallow so petals stay near eye level. Audio reactivity is low; bass adds only gentle vertical motion.",
  },
  {
    id: "solar-wind",
    display_name: "Solar Wind",
    blurb: "Charged plasma streaks racing past the camera in a coronal magnetic field, audio bass intensifying the eruption arcs.",
    atlas_prompt:
      "glowing plasma streaks, sun flare arcs, magnetic field tendrils in vivid orange, yellow, and white, each tile a single luminous streak centered on pure black, photographed as if from the NASA Solar Dynamics Observatory",
    preset: {
      particle_size: 0.05,
      size_variance: 0.7,
      velocity_stretch: 4.5,
      curl_scale: 1.4,
      velocity_damp: 0.98,
      audio_gain: 2.2,
      volume_size: [4.5, 0.6, 4.5],
      wave_amplitude: 0.3,
      flow_drift_x: 1.5,
      corona_boost: 6.5,
      dance_amount: 0.2,
      camera_radius: 5.5,
      camera_height: 0.5,
      camera_orbit_speed: 0.03,
      fov_degrees: 55,
    },
    vibe: ["cosmic", "energetic", "dramatic", "stellar", "fiery"],
    motion: 0.85,
    palette_anchor: ["#000000", "#3a0e02", "#dd5a1a", "#ffeb70"],
    audio_affinity: { bass: 0.9, mid: 0.6, treble: 0.3 },
    techniques: ["instanced_particles", "velocity_stretching", "corona_arcs", "image_atlas_sampling"],
    technical_notes:
      "65,536 plasma streaks race through a strongly stretched curl-noise field with a dominant horizontal current. Velocity stretching is set very high so each particle reads as a streak rather than a sprite. Bass amplifies vertical curl strongly, producing solar corona arcs erupting from the medium on every kick.",
  },
  {
    id: "schooling-fish",
    display_name: "Schooling Fish",
    blurb: "A tight school of silver fish moving as one organism through a tropical reef, dappled light, slow camera orbit at depth.",
    atlas_prompt:
      "small silvery blue fish in various swimming poses — side profile, three-quarter view, tail flicks — with dappled underwater light playing on their scales, each tile one fish centered on a deep teal-black background, photorealistic shallow depth of field",
    preset: {
      particle_size: 0.04,
      size_variance: 0.35,
      velocity_stretch: 1.0,
      curl_scale: 1.6,
      velocity_damp: 0.99,
      audio_gain: 1.0,
      volume_size: [2.5, 0.6, 2.5],
      wave_amplitude: 0.35,
      flow_drift_x: 0.4,
      corona_boost: 0.8,
      dance_amount: 0.6,
      camera_radius: 3.5,
      camera_height: 0.4,
      camera_orbit_speed: 0.04,
      fov_degrees: 50,
    },
    vibe: ["aquatic", "fluid", "organic", "alive", "schooling"],
    motion: 0.7,
    palette_anchor: ["#021a26", "#063e54", "#9bbed1", "#dee8ed"],
    audio_affinity: { bass: 0.4, mid: 0.6, treble: 0.4 },
    techniques: ["instanced_particles", "tight_curl_coupling", "image_atlas_sampling", "wave_attractor"],
    technical_notes:
      "65,536 fish particles cluster in a tight volume via high curl_scale, so the school holds together while flowing through the curl-noise field. Low size_variance keeps the fish uniformly sized. Per-particle rotation drives subtle nodding so individual fish read as alive within the collective motion.",
  },
  {
    id: "murmuration",
    display_name: "Murmuration",
    blurb: "Thousands of starlings emergently flocking against a dusk sky, their swarm shape morphing on the music's pulse.",
    atlas_prompt:
      "small dark bird silhouettes (starlings) in flight, various wing positions — fully extended, half-folded, banking — each tile one silhouette in deep purple-black centered on a soft dusk gradient (orange below, dusty purple above)",
    preset: {
      particle_size: 0.025,
      size_variance: 1.0,
      velocity_stretch: 1.5,
      curl_scale: 2.2,
      velocity_damp: 0.985,
      audio_gain: 1.3,
      volume_size: [4.0, 1.2, 4.0],
      wave_amplitude: 0.4,
      flow_drift_x: 0.5,
      corona_boost: 2.5,
      dance_amount: 0.4,
      camera_radius: 5.0,
      camera_height: 0.7,
      camera_orbit_speed: 0.03,
      fov_degrees: 55,
    },
    vibe: ["emergent", "dusk", "atmospheric", "natural", "organic"],
    motion: 0.75,
    palette_anchor: ["#1c1224", "#3a223a", "#6e4030", "#c97c45"],
    audio_affinity: { bass: 0.6, mid: 0.5, treble: 0.3 },
    techniques: ["instanced_particles", "curl_noise_3d", "image_atlas_sampling"],
    technical_notes:
      "65,536 starling particles flock through a fine-grained curl-noise field with high spatial frequency, producing the rapid local turbulence that characterizes real murmurations. Bass amplifies vertical curl so the swarm pulses upward on each beat, mirroring the visible breathing of real flocks.",
  },
  {
    id: "embers-rising",
    display_name: "Embers Rising",
    blurb: "Hot embers from a campfire spiraling upward through still night air, bursting into corona arcs on bass hits.",
    atlas_prompt:
      "glowing campfire embers — small bright orange and red sparks of varying intensity, some white-hot at the core fading to deep orange edges — each tile one ember on pure black, soft bloom around the brightest ones",
    preset: {
      particle_size: 0.035,
      size_variance: 1.0,
      velocity_stretch: 2.5,
      curl_scale: 1.8,
      velocity_damp: 0.99,
      audio_gain: 2.5,
      volume_size: [3.0, 1.2, 3.0],
      wave_amplitude: 0.15,
      flow_drift_x: 0.3,
      corona_boost: 8.0,
      dance_amount: 0.2,
      camera_radius: 4.0,
      camera_height: 0.35,
      camera_orbit_speed: 0.025,
      fov_degrees: 55,
    },
    vibe: ["primal", "warm", "fiery", "intimate", "nocturnal"],
    motion: 0.7,
    palette_anchor: ["#000000", "#2a0d04", "#cc4a14", "#fcb45a"],
    audio_affinity: { bass: 0.9, mid: 0.5, treble: 0.5 },
    techniques: ["instanced_particles", "corona_arcs", "image_atlas_sampling", "additive_brightness"],
    technical_notes:
      "65,536 ember particles drift slowly in a curl-noise field with very high bass-driven vertical curl boost. Each bass hit sends a column of embers shooting upward in coordinated arcs, mimicking the way real campfire sparks pulse with crackling logs.",
  },
  {
    id: "falling-snow",
    display_name: "Falling Snow",
    blurb: "Snowflakes drifting slowly past the camera through a quiet winter night, the only motion when the music pulses.",
    atlas_prompt:
      "individual snowflakes with intricate six-fold crystal geometry, varied designs — branching dendrites, stellar plates, simple needles — each tile one bright white snowflake centered on midnight blue-black, photographed against a dark background with soft bokeh",
    preset: {
      particle_size: 0.04,
      size_variance: 0.9,
      velocity_stretch: 0.6,
      curl_scale: 0.4,
      velocity_damp: 0.995,
      audio_gain: 0.4,
      volume_size: [4.5, 1.5, 4.5],
      wave_amplitude: 0.15,
      flow_drift_x: 0.15,
      corona_boost: 0.4,
      dance_amount: 0.15,
      camera_radius: 4.5,
      camera_height: 1.0,
      camera_orbit_speed: 0.018,
      fov_degrees: 55,
    },
    vibe: ["serene", "quiet", "winter", "delicate", "contemplative"],
    motion: 0.3,
    palette_anchor: ["#020412", "#0c1a3a", "#7a96c4", "#e0eaf8"],
    audio_affinity: { bass: 0.2, mid: 0.2, treble: 0.3 },
    techniques: ["instanced_particles", "low_audio_reactivity", "image_atlas_sampling"],
    technical_notes:
      "65,536 snowflake particles drift very slowly through a low-frequency curl field with high damping so they take their time descending. Audio reactivity is intentionally muted; only the loudest bass produces visible motion change, preserving the quiet winter mood.",
  },
  {
    id: "galactic-dust",
    display_name: "Galactic Dust",
    blurb: "Cosmic dust and distant stars drifting in slow orbit, camera moving through an interstellar field at a dreamlike pace.",
    atlas_prompt:
      "deep space objects — pinpoint stars in white and blue, swirling dust clouds in dusty rose and indigo, distant galaxies as soft glowing smudges — each tile one element centered on pure black, photographed as if through Hubble telescope",
    preset: {
      particle_size: 0.06,
      size_variance: 1.0,
      velocity_stretch: 0.8,
      curl_scale: 0.3,
      velocity_damp: 0.998,
      audio_gain: 0.5,
      volume_size: [7.0, 2.0, 7.0],
      wave_amplitude: 0.1,
      flow_drift_x: 0.1,
      corona_boost: 0.5,
      dance_amount: 0.1,
      camera_radius: 7.5,
      camera_height: 0.8,
      camera_orbit_speed: 0.015,
      fov_degrees: 60,
    },
    vibe: ["cosmic", "vast", "dreamlike", "contemplative", "stellar"],
    motion: 0.4,
    palette_anchor: ["#02010a", "#1a0a2a", "#5a4880", "#c0a8e0"],
    audio_affinity: { bass: 0.3, mid: 0.2, treble: 0.4 },
    techniques: ["instanced_particles", "wide_volume", "image_atlas_sampling"],
    technical_notes:
      "65,536 cosmic dust particles drift through an unusually wide volume with very high velocity damping, simulating the timeless slow motion of deep space. The flow field is low-frequency so structures are large; the camera is far back so individual particles read as pinpoint stars.",
  },
  {
    id: "origami-flock",
    display_name: "Origami Flock",
    blurb: "Paper birds and butterflies drifting through a warm museum atrium, each one nodding to the music with its own tempo.",
    atlas_prompt:
      "small folded origami paper birds (cranes, swallows) and butterflies in pastel cream, soft pink, lavender, mint, each one with visible paper texture and clean fold creases, centered on a warm gray-beige background",
    preset: {
      particle_size: 0.05,
      size_variance: 0.5,
      velocity_stretch: 0.8,
      curl_scale: 0.6,
      velocity_damp: 0.992,
      audio_gain: 0.6,
      volume_size: [4.0, 1.0, 4.0],
      wave_amplitude: 0.2,
      flow_drift_x: 0.4,
      corona_boost: 1.0,
      dance_amount: 1.4,
      camera_radius: 4.5,
      camera_height: 0.55,
      camera_orbit_speed: 0.025,
      fov_degrees: 52,
    },
    vibe: ["light", "contemplative", "museum", "soft", "papercraft"],
    motion: 0.45,
    palette_anchor: ["#2a241f", "#5a4838", "#e0c8b0", "#f8e8d6"],
    audio_affinity: { bass: 0.4, mid: 0.4, treble: 0.5 },
    techniques: ["instanced_particles", "per_particle_rotation", "image_atlas_sampling"],
    technical_notes:
      "65,536 origami paper bird and butterfly particles drift gently through a warm-toned atrium. The dance_amount is set high so per-particle rotation reads clearly — each paper bird visibly nods to the bass at its own tempo, producing a flock-wide ripple effect on each beat.",
  },
  {
    id: "magnetosphere-revisited",
    display_name: "Magnetosphere Revisited",
    blurb: "A modern take on Robert Hodgin's iTunes visualizer. Soft-light strands trail across the screen leaving glowing wakes, dramatic camera moves, bass-driven bloom on every drop.",
    atlas_prompt:
      "glowing soft-light strands and lens flare orbs, bright white-hot centers fading through warm yellow to cool blue-cyan edges, with rare warm-orange highlights, each tile one luminous element centered on pure black, painted-light photography aesthetic",
    preset: {
      particle_size: 0.04,
      size_variance: 0.7,
      velocity_stretch: 3.2,
      curl_scale: 1.1,
      velocity_damp: 0.99,
      audio_gain: 1.8,
      volume_size: [3.5, 1.0, 3.5],
      wave_amplitude: 0.05,
      flow_drift_x: 0.35,
      corona_boost: 5.5,
      dance_amount: 0.0,
      camera_radius: 4.2,
      camera_height: 0.55,
      camera_orbit_speed: 0.04,
      fov_degrees: 55,
      trail_decay: 0.94,
    },
    vibe: ["luminous", "cosmic", "dramatic", "flowing", "iconic"],
    motion: 0.85,
    palette_anchor: ["#000000", "#0a1a40", "#3acccc", "#ffe9b0"],
    audio_affinity: { bass: 0.8, mid: 0.5, treble: 0.4 },
    techniques: ["instanced_particles", "screen_space_trails", "corona_arcs", "image_atlas_sampling"],
    technical_notes:
      "Tribute to Robert Hodgin's iTunes Magnetosphere visualizer. Particles leave persistent trails on a screen-space accumulator buffer that fades 6% per frame, producing the characteristic glowing streams. Bass spikes drive vertical curl arcs; camera orbit is faster than the calm presets for cinematic motion. The atlas is soft light-strand sprites so each particle reads as a stroke of luminous paint.",
  },
  {
    id: "fairy-lights",
    display_name: "Fairy Lights",
    blurb: "Soft glowing orbs of light streaming across a dark canvas, leaving long persistent trails like a long-exposure photograph of moving lights.",
    atlas_prompt:
      "a single bright glowing point of light with a soft circular halo, each tile a different colored orb — pure white, electric cyan, soft blue, lime green, warm yellow, pale pink, golden orange — centered on pure black, photographed as macro of a single fairy light with shallow depth of field and circular bokeh",
    preset: {
      particle_size: 0.045,
      size_variance: 0.85,
      velocity_stretch: 2.4,
      curl_scale: 0.9,
      velocity_damp: 0.99,
      audio_gain: 1.8,
      volume_size: [4.0, 1.2, 4.0],
      wave_amplitude: 0.1,
      flow_drift_x: 0.45,
      corona_boost: 5.0,
      dance_amount: 0.0,
      camera_radius: 4.5,
      camera_height: 0.55,
      camera_orbit_speed: 0.045,
      fov_degrees: 55,
      trail_decay: 0.95,
    },
    vibe: ["luminous", "magical", "cinematic", "flowing", "celebratory"],
    motion: 0.8,
    palette_anchor: ["#000000", "#1a2b66", "#c8e0ff", "#ffe9b0"],
    audio_affinity: { bass: 0.7, mid: 0.5, treble: 0.5 },
    techniques: ["instanced_particles", "screen_space_trails", "corona_arcs", "image_atlas_sampling"],
    technical_notes:
      "Long-exposure-photograph aesthetic. A 95% per-frame trail decay produces persistent glowing streams as multicolored orbs sweep across the canvas. The atlas is single-orb-per-tile soft lights, so each particle reads as a discrete bokeh point trailing color through space.",
  },
  {
    id: "aurora-curtains",
    display_name: "Aurora Curtains",
    blurb: "Vertical curtains of green and teal light shimmering across a polar night sky, undulating slowly with the music.",
    atlas_prompt:
      "soft vertical glowing light columns in aurora colors — electric green, teal, deep purple at the bottom — each tile one luminous vertical strand on a black night-sky background, photographed as a real aurora borealis with soft diffuse glow",
    preset: {
      particle_size: 0.06,
      size_variance: 0.8,
      velocity_stretch: 1.6,
      curl_scale: 0.5,
      velocity_damp: 0.995,
      audio_gain: 1.2,
      volume_size: [4.5, 2.2, 4.5],
      wave_amplitude: 0.1,
      flow_drift_x: 0.15,
      corona_boost: 2.5,
      dance_amount: 0.0,
      camera_radius: 5.0,
      camera_height: 1.1,
      camera_orbit_speed: 0.02,
      fov_degrees: 60,
      trail_decay: 0.93,
    },
    vibe: ["polar", "shimmering", "atmospheric", "atmospheric", "natural"],
    motion: 0.55,
    palette_anchor: ["#020412", "#0a3a3a", "#3acca0", "#b8e8d8"],
    audio_affinity: { bass: 0.4, mid: 0.5, treble: 0.6 },
    techniques: ["instanced_particles", "screen_space_trails", "tall_volume", "image_atlas_sampling"],
    technical_notes:
      "Tall-volume curtain of vertical light strands with 7% per-frame trail decay producing the characteristic shimmering veils of an aurora display. The camera sits higher than usual to see the vertical structure; the wave attractor is shallow so particles drift gently rather than crashing.",
  },
  {
    id: "comet-field",
    display_name: "Comet Field",
    blurb: "A field of comets streaking through deep space, bright nuclei pulled into elongated tails by velocity and trail decay.",
    atlas_prompt:
      "bright comet head with glowing white-blue nucleus and faint outer corona, each tile a single comet on pure black space, varied colors — pure white, cool blue, warm orange, pale green — photographed with telescope macro detail",
    preset: {
      particle_size: 0.035,
      size_variance: 0.7,
      velocity_stretch: 5.0,
      curl_scale: 0.8,
      velocity_damp: 0.985,
      audio_gain: 2.0,
      volume_size: [5.0, 1.5, 5.0],
      wave_amplitude: 0.2,
      flow_drift_x: 1.5,
      corona_boost: 4.0,
      dance_amount: 0.0,
      camera_radius: 5.0,
      camera_height: 0.5,
      camera_orbit_speed: 0.035,
      fov_degrees: 55,
      trail_decay: 0.96,
    },
    vibe: ["cosmic", "kinetic", "stellar", "dramatic", "streaked"],
    motion: 0.85,
    palette_anchor: ["#000000", "#0a1830", "#a8d0ff", "#ffd8a0"],
    audio_affinity: { bass: 0.8, mid: 0.5, treble: 0.4 },
    techniques: ["instanced_particles", "screen_space_trails", "velocity_stretching", "image_atlas_sampling"],
    technical_notes:
      "Heavy velocity stretching combined with 96% per-frame trail decay produces the comet-streaking effect. Particles draw long persistent tails as they cross the volume. The strong horizontal current ensures the streaks have a dominant motion direction. Bass pulses drive the corona arcs erupting from the comet field.",
  },
  {
    id: "lava-flow",
    display_name: "Lava Flow",
    blurb: "A river of molten lava crawling slowly across the canvas, hot orange-red glowing through dark crust, bass triggering plumes of fire.",
    atlas_prompt:
      "molten lava droplets and hot stones — bright orange-yellow at the center fading to deep crimson edges, with darker basalt crust patches — each tile one molten element centered on pure black, photographed in macro with extreme contrast",
    preset: {
      particle_size: 0.07,
      size_variance: 0.9,
      velocity_stretch: 0.8,
      curl_scale: 0.4,
      velocity_damp: 0.995,
      audio_gain: 1.6,
      volume_size: [4.0, 0.4, 4.0],
      wave_amplitude: 0.35,
      flow_drift_x: 0.4,
      corona_boost: 5.0,
      dance_amount: 0.1,
      camera_radius: 4.0,
      camera_height: 0.4,
      camera_orbit_speed: 0.018,
      fov_degrees: 55,
      trail_decay: 0,
    },
    vibe: ["primal", "hot", "geological", "dense", "molten"],
    motion: 0.55,
    palette_anchor: ["#0a0202", "#3a0a02", "#cc4a18", "#ffb868"],
    audio_affinity: { bass: 0.8, mid: 0.5, treble: 0.3 },
    techniques: ["instanced_particles", "wave_attractor", "corona_arcs", "image_atlas_sampling"],
    technical_notes:
      "65,536 lava droplet particles attach to a shallow wave-attractor surface representing the lava-flow surface. Heavy velocity damping makes the medium move slowly like real magma; bass-driven corona produces explosive plume events from beneath the crust. Camera sits low at flow level for dramatic angle.",
  },
  {
    id: "fireflies",
    display_name: "Fireflies",
    blurb: "A field of fireflies blinking on a warm summer night, soft trails as they drift between visible flashes.",
    atlas_prompt:
      "single firefly with a glowing yellow-green abdomen, soft blurry bokeh halo around the light, varied intensity — some bright, some dim — each tile one firefly centered on a deep warm-black night background",
    preset: {
      particle_size: 0.035,
      size_variance: 1.0,
      velocity_stretch: 1.5,
      curl_scale: 0.7,
      velocity_damp: 0.992,
      audio_gain: 1.4,
      volume_size: [4.0, 1.5, 4.0],
      wave_amplitude: 0.15,
      flow_drift_x: 0.2,
      corona_boost: 3.5,
      dance_amount: 0.0,
      camera_radius: 4.5,
      camera_height: 0.55,
      camera_orbit_speed: 0.025,
      fov_degrees: 55,
      trail_decay: 0.91,
    },
    vibe: ["nocturnal", "warm", "magical", "summer", "soft"],
    motion: 0.55,
    palette_anchor: ["#020404", "#1a2a14", "#a8c468", "#f8e8a0"],
    audio_affinity: { bass: 0.5, mid: 0.4, treble: 0.5 },
    techniques: ["instanced_particles", "screen_space_trails", "corona_arcs", "image_atlas_sampling"],
    technical_notes:
      "Moderate trail decay (0.91) produces visible trails between firefly blinks. Bass-driven corona arcs make the field pulse upward on each beat as if reacting to ambient sound. The deep warm-black palette plus the glowing yellow-green abdomens creates the summer-evening mood.",
  },
  {
    id: "confetti-burst",
    display_name: "Confetti Burst",
    blurb: "Bright confetti exploding outward in celebration, dense multicolored bursts on every drop, joyful and kinetic.",
    atlas_prompt:
      "small bright multicolored confetti pieces in various shapes — rectangles, circles, stars — in saturated red, blue, gold, lime green, hot pink, against a pure black background, each tile one confetti piece in macro detail",
    preset: {
      particle_size: 0.035,
      size_variance: 0.7,
      velocity_stretch: 2.0,
      curl_scale: 1.2,
      velocity_damp: 0.985,
      audio_gain: 2.4,
      volume_size: [4.0, 1.5, 4.0],
      wave_amplitude: 0.1,
      flow_drift_x: 0.2,
      corona_boost: 7.0,
      dance_amount: 0.8,
      camera_radius: 4.2,
      camera_height: 0.55,
      camera_orbit_speed: 0.05,
      fov_degrees: 55,
      trail_decay: 0,
    },
    vibe: ["joyful", "celebratory", "kinetic", "colorful", "festive"],
    motion: 0.85,
    palette_anchor: ["#000000", "#c81818", "#f0c000", "#1898d0"],
    audio_affinity: { bass: 0.9, mid: 0.6, treble: 0.6 },
    techniques: ["instanced_particles", "corona_arcs", "per_particle_rotation", "image_atlas_sampling"],
    technical_notes:
      "Very high bass-driven corona boost produces explosive radial bursts of confetti on each beat. High audio gain and dance amount makes the whole field react sharply to music. The saturated rainbow palette plus the bursting motion gives a celebratory mood; works well for upbeat music drops.",
  },
  {
    id: "meteor-shower",
    display_name: "Meteor Shower",
    blurb: "A Perseid-style meteor shower across the night sky, bright streaks crossing the canvas, the rare ones bursting bright.",
    atlas_prompt:
      "bright meteor streaks — thin white-hot heads with faintly colored tails in blue-green, yellow, pale pink — each tile one meteor on pure dark sky background, photographed as a long-exposure astrophotograph",
    preset: {
      particle_size: 0.025,
      size_variance: 1.0,
      velocity_stretch: 6.0,
      curl_scale: 0.4,
      velocity_damp: 0.99,
      audio_gain: 2.0,
      volume_size: [5.0, 1.5, 5.0],
      wave_amplitude: 0.05,
      flow_drift_x: 2.0,
      corona_boost: 4.5,
      dance_amount: 0.0,
      camera_radius: 5.0,
      camera_height: 0.65,
      camera_orbit_speed: 0.03,
      fov_degrees: 60,
      trail_decay: 0.97,
    },
    vibe: ["cosmic", "stellar", "dramatic", "streaky", "celestial"],
    motion: 0.85,
    palette_anchor: ["#020208", "#0a1830", "#88c8ff", "#fff8b0"],
    audio_affinity: { bass: 0.7, mid: 0.4, treble: 0.5 },
    techniques: ["instanced_particles", "screen_space_trails", "velocity_stretching", "image_atlas_sampling"],
    technical_notes:
      "Extreme velocity stretching (6x) plus extreme trail decay (0.97) and strong horizontal drift produces clean meteor streaks across the canvas. Heads are bright; tails persist for many frames before fading. Bass spikes drive the corona arcs for the rare 'fireball' moments.",
  },
  {
    id: "soap-bubbles",
    display_name: "Soap Bubbles",
    blurb: "Iridescent soap bubbles rising and shimmering through soft afternoon light, gentle and contemplative.",
    atlas_prompt:
      "iridescent soap bubbles — translucent spheres with rainbow color shifts across their surface, varying sizes — each tile one bubble centered on a soft warm gray-cream background, photographed as a macro of real soap bubbles with shallow depth of field",
    preset: {
      particle_size: 0.07,
      size_variance: 0.95,
      velocity_stretch: 0.8,
      curl_scale: 0.5,
      velocity_damp: 0.997,
      audio_gain: 0.7,
      volume_size: [3.5, 1.5, 3.5],
      wave_amplitude: 0.2,
      flow_drift_x: 0.15,
      corona_boost: 1.5,
      dance_amount: 0.3,
      camera_radius: 4.0,
      camera_height: 0.6,
      camera_orbit_speed: 0.02,
      fov_degrees: 55,
      trail_decay: 0,
    },
    vibe: ["light", "iridescent", "contemplative", "delicate", "playful"],
    motion: 0.4,
    palette_anchor: ["#2a2820", "#7a7468", "#d4c8b8", "#fcf2dc"],
    audio_affinity: { bass: 0.3, mid: 0.3, treble: 0.4 },
    techniques: ["instanced_particles", "image_atlas_sampling", "soft_motion"],
    technical_notes:
      "Soft warm palette and very high velocity damping make the bubbles drift slowly. The atlas captures the natural iridescence so each particle reads as a real soap bubble. Camera circles slowly at eye level so the bubbles appear suspended in front of the viewer.",
  },
  {
    id: "bee-swarm",
    display_name: "Bee Swarm",
    blurb: "A swarm of golden honeybees moving as one organism, separation pushing them apart while alignment keeps the entire mass flying the same direction.",
    atlas_prompt:
      "golden honeybees in various flight poses, fuzzy yellow-and-black striped bodies with translucent wings caught in motion blur, each tile one bee centered on a soft warm-black background, photographed in macro detail",
    preset: {
      particle_size: 0.032,
      size_variance: 0.4,
      velocity_stretch: 1.4,
      curl_scale: 1.2,
      velocity_damp: 0.99,
      audio_gain: 1.4,
      volume_size: [3.0, 1.0, 3.0],
      wave_amplitude: 0.15,
      flow_drift_x: 0.3,
      corona_boost: 2.5,
      dance_amount: 0.0,
      camera_radius: 4.0,
      camera_height: 0.55,
      camera_orbit_speed: 0.03,
      fov_degrees: 55,
      trail_decay: 0,
      flock_separation: 0.6,
      flock_alignment: 0.55,
      flock_cohesion: 0.3,
      flock_radius: 0.16,
    },
    vibe: ["agricultural", "warm", "alive", "golden", "swarm"],
    motion: 0.7,
    palette_anchor: ["#0a0804", "#3a2812", "#c89018", "#f4d05c"],
    audio_affinity: { bass: 0.4, mid: 0.7, treble: 0.5 },
    techniques: ["instanced_particles", "spatial_hash_flocking", "image_atlas_sampling"],
    technical_notes:
      "Real Reynolds-Boids flocking via the spatial-hash grid. High separation keeps the bees from passing through each other, high alignment makes them adopt a common heading, modest cohesion keeps the swarm coherent. Curl noise still provides the underlying chaotic motion so the flock doesn't lock into a rigid formation.",
  },
  {
    id: "bat-cave-emergence",
    display_name: "Bat Cave Emergence",
    blurb: "Thousands of bats spiraling out of a cave at dusk, separation keeping them from collision, strong alignment driving the whole mass out into the open sky.",
    atlas_prompt:
      "dark bat silhouettes in flight, wings extended at various angles — fully spread, half-folded, banking sharply — each tile one bat in pure black against a warm dusk sky gradient (orange below fading to deep purple above)",
    preset: {
      particle_size: 0.038,
      size_variance: 1.0,
      velocity_stretch: 2.4,
      curl_scale: 1.0,
      velocity_damp: 0.985,
      audio_gain: 1.7,
      volume_size: [4.0, 1.5, 4.0],
      wave_amplitude: 0.1,
      flow_drift_x: 1.2,
      corona_boost: 4.5,
      dance_amount: 0.0,
      camera_radius: 5.0,
      camera_height: 0.6,
      camera_orbit_speed: 0.025,
      fov_degrees: 55,
      trail_decay: 0,
      flock_separation: 0.5,
      flock_alignment: 0.65,
      flock_cohesion: 0.2,
      flock_radius: 0.22,
    },
    vibe: ["dusk", "emergent", "nocturnal", "dramatic", "biblical"],
    motion: 0.85,
    palette_anchor: ["#180a1a", "#3a1820", "#7a3818", "#d06820"],
    audio_affinity: { bass: 0.7, mid: 0.4, treble: 0.6 },
    techniques: ["instanced_particles", "spatial_hash_flocking", "corona_arcs", "image_atlas_sampling"],
    technical_notes:
      "Strong alignment (0.65) drives all bats in the same direction — the iconic cave-emergence stream. Strong horizontal drift adds the dominant cave-exit motion. Bass-driven corona arcs produce upward bursts as if the swarm is responding to sudden sounds. Low cohesion lets the stream spread out into the open sky.",
  },
  {
    id: "salmon-run",
    display_name: "Salmon Run",
    blurb: "Silver salmon swimming upstream against a powerful current, the entire school holding formation while individual fish push through the flow.",
    atlas_prompt:
      "silver salmon fish in dynamic swimming poses, dappled water highlights on scales, varying body angles — straight ahead, tail-first, broadside — each tile one salmon centered on a deep teal-black water background",
    preset: {
      particle_size: 0.038,
      size_variance: 0.35,
      velocity_stretch: 1.2,
      curl_scale: 1.0,
      velocity_damp: 0.99,
      audio_gain: 1.2,
      volume_size: [4.0, 0.8, 4.0],
      wave_amplitude: 0.25,
      flow_drift_x: -0.6,
      corona_boost: 1.5,
      dance_amount: 0.4,
      camera_radius: 4.5,
      camera_height: 0.45,
      camera_orbit_speed: 0.025,
      fov_degrees: 50,
      trail_decay: 0,
      flock_separation: 0.5,
      flock_alignment: 0.6,
      flock_cohesion: 0.45,
      flock_radius: 0.18,
    },
    vibe: ["aquatic", "determined", "schooling", "powerful", "natural"],
    motion: 0.65,
    palette_anchor: ["#021820", "#08383a", "#a8c4c4", "#e8eef0"],
    audio_affinity: { bass: 0.5, mid: 0.5, treble: 0.4 },
    techniques: ["instanced_particles", "spatial_hash_flocking", "wave_attractor", "image_atlas_sampling"],
    technical_notes:
      "Negative flow_drift_x simulates the downstream current; high alignment and cohesion keep the salmon pointed upstream so the school visibly resists the flow. The wave attractor at the surface gives the rolling-water effect. Real Reynolds flocking lets individual fish push past each other while the school holds its formation.",
  },
  {
    id: "jellyfish-bloom",
    display_name: "Jellyfish Bloom",
    blurb: "A bioluminescent bloom of jellyfish drifting in deep ocean current, their soft pulsing glow synchronized to bass frequencies.",
    atlas_prompt:
      "translucent bioluminescent jellyfish with soft glowing inner cores in cyan-blue and pale lavender, gentle bell shapes with trailing tentacles, each tile one jelly centered on a deep ocean black background, photographed as a bioluminescent macro",
    preset: {
      particle_size: 0.06,
      size_variance: 0.85,
      velocity_stretch: 0.8,
      curl_scale: 0.4,
      velocity_damp: 0.997,
      audio_gain: 0.9,
      volume_size: [4.0, 1.8, 4.0],
      wave_amplitude: 0.2,
      flow_drift_x: 0.15,
      corona_boost: 2.5,
      dance_amount: 0.3,
      camera_radius: 4.5,
      camera_height: 0.55,
      camera_orbit_speed: 0.022,
      fov_degrees: 55,
      trail_decay: 0.92,
      flock_separation: 0.35,
      flock_alignment: 0.2,
      flock_cohesion: 0.4,
      flock_radius: 0.25,
    },
    vibe: ["bioluminescent", "drifting", "serene", "underwater", "alive"],
    motion: 0.5,
    palette_anchor: ["#020a14", "#0a3850", "#3acccc", "#b8e8e8"],
    audio_affinity: { bass: 0.6, mid: 0.4, treble: 0.5 },
    techniques: ["instanced_particles", "spatial_hash_flocking", "screen_space_trails", "image_atlas_sampling"],
    technical_notes:
      "Combines trail decay (0.92) for the bioluminescent persistent-glow effect with gentle cohesion-led flocking. Low alignment means each jelly drifts somewhat independently — they cluster but don't all face the same direction. Bass-driven corona produces synchronized upward pulsing as if the bloom is breathing.",
  },
  {
    id: "hummingbird-garden",
    display_name: "Hummingbird Garden",
    blurb: "Iridescent hummingbirds darting through a tropical garden, separation and high audio reactivity producing the characteristic zigzag flight pattern.",
    atlas_prompt:
      "iridescent hummingbirds in various hovering and darting poses, jewel-tone plumage in emerald, ruby red, sapphire blue, violet, each tile one hummingbird centered on a soft warm-black background with subtle bokeh, photographed in macro detail",
    preset: {
      particle_size: 0.035,
      size_variance: 0.6,
      velocity_stretch: 1.8,
      curl_scale: 1.6,
      velocity_damp: 0.985,
      audio_gain: 1.8,
      volume_size: [3.0, 1.2, 3.0],
      wave_amplitude: 0.2,
      flow_drift_x: 0.3,
      corona_boost: 3.5,
      dance_amount: 0.2,
      camera_radius: 3.8,
      camera_height: 0.55,
      camera_orbit_speed: 0.035,
      fov_degrees: 55,
      trail_decay: 0,
      flock_separation: 0.7,
      flock_alignment: 0.15,
      flock_cohesion: 0.15,
      flock_radius: 0.14,
    },
    vibe: ["iridescent", "tropical", "kinetic", "jewel", "darting"],
    motion: 0.8,
    palette_anchor: ["#020208", "#1a0a24", "#cc1850", "#48c8a0"],
    audio_affinity: { bass: 0.3, mid: 0.4, treble: 0.8 },
    techniques: ["instanced_particles", "spatial_hash_flocking", "high_separation", "image_atlas_sampling"],
    technical_notes:
      "Extreme separation (0.7) with very low alignment and cohesion produces the characteristic hummingbird-pattern — each bird independent, never colliding with another. High treble audio affinity ties their motion to high-frequency content like wingbeats. Rapid curl noise gives the zigzag.",
  },
  {
    id: "flocking-bananas",
    display_name: "Flocking Bananas",
    blurb: "A literal joke for the developer community — what if Nano Banana drew bananas, and they flocked? Bright yellow curved shapes in formation, set to upbeat music.",
    atlas_prompt:
      "cartoon-style bright yellow bananas in various playful poses — peeled, half-peeled, curved, straight, single fruit, bunches — each tile one banana centered on a clean black background, slightly stylized illustration with bold outlines",
    preset: {
      particle_size: 0.045,
      size_variance: 0.7,
      velocity_stretch: 1.5,
      curl_scale: 1.0,
      velocity_damp: 0.99,
      audio_gain: 2.0,
      volume_size: [3.5, 1.0, 3.5],
      wave_amplitude: 0.15,
      flow_drift_x: 0.5,
      corona_boost: 4.0,
      dance_amount: 0.3,
      camera_radius: 4.2,
      camera_height: 0.55,
      camera_orbit_speed: 0.035,
      fov_degrees: 55,
      trail_decay: 0,
      flock_separation: 0.55,
      flock_alignment: 0.5,
      flock_cohesion: 0.35,
      flock_radius: 0.18,
    },
    vibe: ["playful", "absurd", "celebratory", "yellow", "developer-joke"],
    motion: 0.8,
    palette_anchor: ["#000000", "#3a2810", "#f0c020", "#fff8c0"],
    audio_affinity: { bass: 0.7, mid: 0.5, treble: 0.5 },
    techniques: ["instanced_particles", "spatial_hash_flocking", "corona_arcs", "image_atlas_sampling"],
    technical_notes:
      "A wink to Nano Banana, the image-generation model behind Prism's atlas pipeline. A field of cartoon bananas flocking via Reynolds rules: well-balanced separation/alignment/cohesion produces a coherent banana-cloud that moves as one organism through the volume. Bass drives upward corona arcs of erupting fruit.",
  },
  {
    id: "coral-garden",
    display_name: "Coral Garden",
    blurb: "A living reef of coral polyps gently swaying in current, deep ocean color, slow camera at the seafloor.",
    atlas_prompt:
      "vibrant coral polyps in vivid colors — magenta tips fading to teal-green branches, bright red brain corals, orange tubastraea — each tile a single coral cluster centered on a deep ocean blue-black background, photographed in macro detail with natural underwater light",
    preset: {
      particle_size: 0.06,
      size_variance: 0.8,
      velocity_stretch: 0.6,
      curl_scale: 0.5,
      velocity_damp: 0.995,
      audio_gain: 1.0,
      volume_size: [3.5, 0.5, 3.5],
      wave_amplitude: 0.8,
      flow_drift_x: 0.15,
      corona_boost: 1.5,
      dance_amount: 0.7,
      camera_radius: 4.0,
      camera_height: 0.3,
      camera_orbit_speed: 0.02,
      fov_degrees: 55,
    },
    vibe: ["aquatic", "alive", "underwater", "vibrant", "organic"],
    motion: 0.5,
    palette_anchor: ["#01151a", "#063848", "#c8284c", "#48c8a8"],
    audio_affinity: { bass: 0.5, mid: 0.4, treble: 0.5 },
    techniques: ["instanced_particles", "wave_attractor", "image_atlas_sampling", "per_particle_rotation"],
    technical_notes:
      "65,536 coral polyp particles attach to a strong wave-attractor surface representing the seafloor. The wave amplitude is high so the coral sways visibly in current. Per-particle rotation produces gentle swaying of individual polyps; bass-driven corona produces occasional upward bloom events like a coral reef in spawning.",
  },
];

async function generateAtlas(prompt: string, outPath: string): Promise<void> {
  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY ?? process.env.VITE_GEMINI_API_KEY,
  });
  const total = ATLAS_TILES_PER_ROW * ATLAS_TILES_PER_ROW;
  const atlasPrompt =
    `Create one square image (${ATLAS_SIZE}x${ATLAS_SIZE}) showing ` +
    `a grid of ${ATLAS_TILES_PER_ROW}x${ATLAS_TILES_PER_ROW} = ${total} ` +
    `distinct variations of: ${prompt}. ` +
    `Each tile is ${TILE_SIZE}x${TILE_SIZE}. ` +
    `Variations differ in pose, color, and lighting but follow the same subject. ` +
    `Each tile is centered on its subject, isolated against a soft dark background. ` +
    `The composition is a clean grid with no gaps or borders between tiles.`;
  const response = await ai.models.generateContent({
    model: MODEL_IMAGE,
    contents: atlasPrompt,
  });
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find(
    (p: { inlineData?: { data?: string } }) => p.inlineData?.data,
  );
  if (!imagePart?.inlineData?.data) {
    throw new Error("Nano Banana returned no image data");
  }
  const bytes = Buffer.from(imagePart.inlineData.data, "base64");
  writeFileSync(outPath, bytes);
}

function writePreset(def: ConceptDef, repoRoot: string): void {
  const path = join(repoRoot, `public/presets/particles/${def.id}.json`);
  const json = {
    name: def.display_name,
    atlas_url: `/presets/particles/${def.id}-atlas.png`,
    atlas_size: ATLAS_TILES_PER_ROW,
    ...def.preset,
  };
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
}

function writeEntry(def: ConceptDef, repoRoot: string): void {
  const path = join(repoRoot, `catalog/entries/particles_${def.id}.json`);
  if (existsSync(path)) return; // don't clobber an already-annotated entry
  const entry = {
    id: `particles:${def.id}`,
    schema_version: 2,
    source: {
      type: "particles",
      loader: "url",
      url: `/presets/particles/${def.id}.json`,
    },
    display: {
      name: def.display_name,
      author: "prism",
      blurb: def.blurb,
    },
    annotation: {
      vibe: def.vibe,
      motion: def.motion,
      palette_anchor: def.palette_anchor,
      audio_affinity: def.audio_affinity,
      techniques: def.techniques,
      technical_notes: def.technical_notes,
      brand_safe: true,
      atelier: true,
      model: "seed",
      version: 1,
      captured_at: new Date().toISOString(),
    },
    assets: {
      textures_needed: [],
      default_image: `/presets/particles/${def.id}-atlas.png`,
    },
    contribution: {
      added_by: "prism",
      added_at: new Date().toISOString().slice(0, 10) + "T00:00:00.000Z",
      license: "MIT",
    },
    compatibility: { renders: true },
  };
  writeFileSync(path, JSON.stringify(entry, null, 2) + "\n");
}

export async function runBuildParticleShowcase(
  repoRoot: string,
  opts: { only?: string; skipAnnotate?: boolean } = {},
): Promise<void> {
  const concepts = opts.only ? CONCEPTS.filter((c) => c.id === opts.only) : CONCEPTS;
  if (concepts.length === 0) {
    console.error(`no concepts matched filter ${JSON.stringify(opts.only)}`);
    return;
  }
  console.log(`[showcase] building ${concepts.length} particle concept${concepts.length === 1 ? "" : "s"}`);
  let ok = 0, captured = 0;
  for (let i = 0; i < concepts.length; i++) {
    const def = concepts[i];
    console.log(`\n[showcase] ${i + 1}/${concepts.length} ${def.id}`);
    const atlasPath = join(repoRoot, `public/presets/particles/${def.id}-atlas.png`);
    try {
      if (!existsSync(atlasPath)) {
        console.log(`  generating atlas via ${MODEL_IMAGE}...`);
        await generateAtlas(def.atlas_prompt, atlasPath);
        console.log(`  atlas saved (${(statSync(atlasPath).size / 1024).toFixed(0)} KB)`);
      } else {
        console.log(`  atlas cached`);
      }
    } catch (err) {
      console.error(`  ATLAS FAILED: ${(err as Error).message}`);
      continue;
    }
    writePreset(def, repoRoot);
    writeEntry(def, repoRoot);
    console.log(`  preset + entry written`);
    if (opts.skipAnnotate) {
      ok++;
      continue;
    }
    try {
      await runAnnotateOne(repoRoot, `particles:${def.id}`, { reuseVideo: false });
      ok++;
      captured++;
    } catch (err) {
      console.log(`  annotate failed (hand-seed entry survives): ${(err as Error).message.split("\n")[0]}`);
      // Even if annotate failed, the entry exists and has a
      // valid hand-seeded annotation. It won't be in the gallery
      // because video URL is missing, but a subsequent
      // `prism annotate particles:<id>` will pick it up.
      ok++;
    }
  }
  console.log(`\n[showcase] done. ${ok}/${concepts.length} concepts ready, ${captured} captured to gallery`);
}
