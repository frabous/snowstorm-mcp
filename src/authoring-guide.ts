const presets = {
  impact: { template: "burst", motion: "dynamic", shape: "point or disc", material: "particles_add" },
  aura: { template: "aura", motion: "dynamic or parametric", shape: "sphere or box", material: "particles_add or particles_alpha" },
  trail: { template: "trail", motion: "parametric", shape: "point", material: "particles_add" },
  shockwave: { template: "shockwave", motion: "static or parametric", shape: "disc", material: "particles_add" },
  smoke: { template: "smoke", motion: "dynamic", shape: "sphere or box", material: "particles_alpha" }
} as const;

export type EffectRole = keyof typeof presets;

export const authoringGuide = `
Snowstorm MCP authoring rules for Blockbuster 1.12:
- Inspect an existing particle before editing and retain every blockbuster:* component.
- Use a small, finite emitter first; increase density only after visual review.
- Use dynamic motion for gravity or collision and parametric motion for controlled paths.
- Collision requires dynamic motion and world-space behavior; local or parametric collision is usually misleading.
- Texture namespaces resolve to resourcepack/assets/<namespace>/textures/<path>.png and are case-sensitive.
- Validate JSON, texture, selectors and lifetime separately from Snowstorm preview. Validate MagicSpells helpers with the target package's own test flow.
- Snowstorm preview and generated GIFs are not evidence of Minecraft/Blockbuster rendering.
- For a multi-layer effect, give each layer one readable role: glow, shape, motion, smoke, debris or accent.
`.trim();

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
