import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/**
 * The post chain.
 *
 * Three things, in the order they matter for a bright snow scene:
 *
 * **Multisampling.** Everything here is hard-edged low-poly geometry against a
 * flat sky — the worst possible case for aliasing, and the case MSAA is best
 * at. A multisampled render target gets it back after moving off the default
 * framebuffer, which a composer otherwise gives up.
 *
 * **Bloom, at a high threshold.** A snowfield lit by direct sun is genuinely
 * over-range in places, and letting only those places bleed is most of what
 * separates "white polygons" from "snow". Threshold is the whole tuning: drop
 * it and the entire slope glows and the picture turns to milk.
 *
 * **A grade.** A gentle vignette and a cool lift in the shadows. The vignette
 * is doing real work — it keeps the eye in the middle of the frame, where the
 * rider is, on a screen that is otherwise uniformly bright to all four corners.
 *
 * `OutputPass` carries the tone mapping and the colour space, which the
 * renderer would otherwise have applied itself.
 */

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uVignette: { value: 0.34 },
    uShadowTint: { value: new THREE.Color('#93b6dc') },
    uShadowLift: { value: 0.1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVignette;
    uniform vec3 uShadowTint;
    uniform float uShadowLift;
    varying vec2 vUv;

    void main() {
      vec4 col = texture2D(tDiffuse, vUv);

      // Shadows go blue on snow, because what is lighting them is the sky.
      float luma = dot(col.rgb, vec3(0.2126, 0.7152, 0.0722));
      float shade = 1.0 - smoothstep(0.0, 0.42, luma);
      col.rgb = mix(col.rgb, col.rgb * uShadowTint, shade * uShadowLift);

      // Vignette, measured from the centre with the aspect left in — a circular
      // falloff on a wide frame darkens the sides far more than the corners.
      vec2 d = vUv - 0.5;
      float v = 1.0 - uVignette * dot(d, d) * 2.2;
      col.rgb *= v;

      gl_FragColor = col;
    }
  `,
};

export function buildComposer(renderer, scene, camera, quality = {}) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());

  // HalfFloat, because bloom has to work on values above 1 to pick out the
  // genuinely over-range highlights rather than everything that is merely white.
  const target = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    samples: quality.msaaSamples ?? 4,
  });

  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));

  // Bloom and the grade are the optional parts. What is *not* optional is the
  // chain itself: the sky is a raw shader that writes its own fragments, so
  // whether it passes through `OutputPass` decides whether it is tone mapped at
  // all. Run it on one tier and not the other and the two look like different
  // times of day.
  let bloom = null;
  if (quality.bloom !== false) {
    bloom = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      quality.bloomStrength ?? 0.34,
      0.7,                                  // radius
      quality.bloomThreshold ?? 0.92
    );
    composer.addPass(bloom);
  }

  if (quality.grade !== false) composer.addPass(new ShaderPass(GradeShader));

  // Tone mapping and colour space live here now, not on the renderer.
  composer.addPass(new OutputPass());

  return {
    composer,
    bloom,
    render: () => composer.render(),
    setSize: (width, height) => composer.setSize(width, height),
    dispose: () => composer.dispose(),
  };
}
