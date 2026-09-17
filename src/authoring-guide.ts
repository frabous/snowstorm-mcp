const presets = {
  impact: { template: "burst", motion: "dynamic", shape: "point or disc", material: "particles_add" },
  aura: { template: "aura", motion: "dynamic or parametric", shape: "sphere or box", material: "particles_add or particles_alpha" },
  trail: { template: "trail", motion: "parametric", shape: "point", material: "particles_add" },
  shockwave: { template: "shockwave", motion: "static or parametric", shape: "disc", material: "particles_add" },
  smoke: { template: "smoke", motion: "dynamic", shape: "sphere or box", material: "particles_alpha" }
} as const;

export type EffectRole = keyof typeof presets;

export const authoringTopics = ["workflow", "components", "blockbuster", "motion", "textures", "magicspells", "validation", "reference-video"] as const;
export type AuthoringTopic = (typeof authoringTopics)[number];

const guideByTopic: Record<AuthoringTopic, string> = {
  workflow: "Snowstorm MCP workflow: inspect a close existing particle; state the visual role; start with a finite low-density emitter; validate JSON and texture; render first/middle/final frames; preserve Blockbuster extensions; validate selectors; then test in Minecraft. Give each composite layer one readable role: geometry, glow, motion, smoke, debris or accent.",
  components: "Components: use instant emission for impacts and flashes, steady emission for auras/trails/smoke, dynamic motion for gravity or debris, and parametric motion for authored paths. Use point shapes for bolts, disc for shockwaves, sphere or box for aura/smoke. Match particles_add or particles_alpha to the target conventions. Never retain mutually exclusive minecraft rate, lifetime or motion components after changing mode.",
  blockbuster: "Blockbuster compatibility: retain every blockbuster:* component unless explicitly changing it. Snowstorm may not preserve unknown extensions during a direct export. Selector custom-name must match selector name; selector Scheme must match the Blockbuster particle filename. A selector package is a mergeable additions list, not an instance-wide replacement. Keep identifiers, texture namespace and resource-pack paths stable unless intentionally changed.",
  motion: "Motion and anchoring: use dynamic motion for gravity/drag/collision, parametric motion for deliberate paths. Collision needs dynamic world-space behavior. Attached auras use emitter_local_space; a fixed burst captures its point at helper launch. Distinguish an orbit, incoming flow, trail and fixed-end whip before writing Molang. Use the actual model-local target point and stable per-particle random branches. Molang angles are degrees.",
  textures: "Textures and UV: namespace:path resolves to assets/<namespace>/textures/<path>.png. Namespace, case, path and PNG must match exactly. Load the real PNG in Snowstorm before judging it. Check texture dimensions, UV bounds, flipbook step and max frame. Do not ship a substitute vanilla texture. Fix thin source artwork or billboard scale before raising particle density.",
  magicspells: "MagicSpells guidance: helper custom-name must equal exactly one selector name; selector Scheme must match the particle file. Use a zero-velocity ParticleProjectileSpell for a short fixed layer and ArmorStandSpell for attached persistent effects. Keep delays in the parent MultiSpell. Do not add gameplay effects to a visual-only layer. This MCP validates particles and selectors; test YAML helpers and live timing in the target server separately.",
  validation: "Validation order: JSON structure, asset integrity, selector-to-particle package links, Snowstorm first/middle/final preview, then Minecraft playback. A pass at one level does not prove the next. Snowstorm PNG/GIF/MP4 proves only the local simulator, never Blockbuster behavior.",
  "reference-video": "Reference-video workflow: call video_import with the user video path; it copies the source to the MCP-managed directory. Call video_analyze for a scene-aware contact sheet and manifest. Use video_extract_frames around a transition. Each frame reports requestedTimecode and actualTimecode; the decoded PTS is authoritative. Separate observed shape, color, origin, destination, timing and camera treatment. Do not mistake a cut, grade or bloom for a particle layer. Turn evidence into a design brief, then implement and render."
};

export const authoringGuide = authoringTopics.map((topic) => guideByTopic[topic]).join("\n\n");

export function authoringGuideFor(topic?: AuthoringTopic): string {
  return topic ? guideByTopic[topic] : authoringGuide;
}

export function designBrief(role: EffectRole, durationSeconds?: number, attached = false) {
  const preset = presets[role];
  return {
    role,
    recommendedTemplate: preset.template,
    emission: role === "aura" ? "steady, finite helper duration" : "instant or short finite burst",
    motion: preset.motion,
    shape: preset.shape,
    material: preset.material,
    localSpace: attached,
    durationSeconds: durationSeconds ?? (role === "aura" ? 2 : 0.8),
    validation: [
      "Validate texture and JSON before rendering.",
      "Render a contact sheet or GIF, then inspect the first, middle and final frame.",
      "Preserve blockbuster:* fields and verify selector links before installation; test MagicSpells helpers separately.",
      "Test in Minecraft before claiming the effect is verified."
    ]
  };
}
