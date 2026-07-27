import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SUN_DIRECTION } from '../world/Environment.js';

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

/**
 * The grade, and the sun shafts, in one pass.
 *
 * They share a pass because they share a texture read and the shafts want to
 * happen *before* the tone curve, while the vignette wants to happen after.
 *
 * The shafts are the cheap version of volumetric light: march a short way from
 * each pixel toward the sun's position on screen, accumulate whatever is bright
 * along the way, and add it back. It is a radial blur of the highlights, which
 * on a scene lit by a low sun over snow is indistinguishable from the real
 * thing — the sun is behind the peaks and the light spills round them.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uVignette: { value: 0.3 },
    uShadowTint: { value: new THREE.Color('#93b6dc') },
    uShadowLift: { value: 0.12 },
    uSunScreen: { value: new THREE.Vector2(0.5, 0.9) },
    uShafts: { value: 0.34 },
    uContrast: { value: 1.06 },
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
    uniform vec2 uSunScreen;
    uniform float uShafts;
    uniform float uContrast;
    varying vec2 vUv;

    const int STEPS = 12;

    void main() {
      vec4 col = texture2D(tDiffuse, vUv);

      // --- Light shafts ------------------------------------------------
      if (uShafts > 0.001) {
        vec2 toSun = uSunScreen - vUv;
        // Fades out behind the camera and at the edges of the frame, where the
        // march would otherwise smear the border pixels into stripes.
        float onScreen = smoothstep(1.4, 0.7, length(uSunScreen - vec2(0.5)));
        vec2 step = toSun * (0.34 / float(STEPS));
        vec2 uv = vUv;
        float weight = 1.0;
        vec3 shaft = vec3(0.0);
        for (int i = 0; i < STEPS; i++) {
          uv += step;
          vec3 s = texture2D(tDiffuse, clamp(uv, 0.0, 1.0)).rgb;
          // Only genuinely bright pixels throw light: everything else is snow,
          // and smearing snow just fogs the picture.
          float bright = max(0.0, dot(s, vec3(0.33)) - 0.85);
          shaft += s * bright * weight;
          weight *= 0.82;
        }
        col.rgb += shaft * (uShafts / float(STEPS)) * onScreen;
      }

      // --- Grade -------------------------------------------------------
      // Shadows go blue on snow, because what is lighting them is the sky.
      float luma = dot(col.rgb, vec3(0.2126, 0.7152, 0.0722));
      float shade = 1.0 - smoothstep(0.0, 0.42, luma);
      col.rgb = mix(col.rgb, col.rgb * uShadowTint, shade * uShadowLift);

      // A gentle S-curve about mid grey. Tone mapping alone leaves the picture
      // correct and flat; this is the bit of contrast that makes it look shot
      // rather than computed.
      col.rgb = (col.rgb - 0.18) * uContrast + 0.18;
      col.rgb = max(col.rgb, 0.0);

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

  /*
   * There is no screen-space ambient occlusion pass here, and that is a
   * decision rather than an omission.
   *
   * `GTAOPass` was tried and produced a near-black panorama. Screen-space AO
   * reads the depth buffer, and this scene runs from half a metre to nine
   * kilometres: out at the far ranges there is no depth precision left, every
   * sample reads as occluded, and the mountains turn into silhouettes. Pulling
   * the far plane in enough to fix it would cut the panorama off.
   *
   * The contact shading is baked into the terrain instead — see the occluder
   * pass in `Terrain.js`. It only works on the ground and only for things that
   * exist at build time, which is a real limitation, and it is still the better
   * trade here.
   */

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

  let grade = null;
  if (quality.grade !== false) {
    grade = new ShaderPass(GradeShader);
    grade.uniforms.uShafts.value = quality.shafts ?? 0.34;
    composer.addPass(grade);
  }

  // Tone mapping and colour space live here now, not on the renderer.
  composer.addPass(new OutputPass());

  // Where the sun is on screen, which is what the shafts radiate from. Behind
  // the camera it is switched off entirely rather than left to smear inward
  // from whichever edge the projection happens to fold it onto.
  const sunWorld = new THREE.Vector3();
  const sunView = new THREE.Vector3();

  const update = () => {
    if (!grade) return;
    sunWorld.copy(SUN_DIRECTION).multiplyScalar(4000).add(camera.position);
    sunView.copy(sunWorld).project(camera);
    const behind = sunView.z > 1;
    grade.uniforms.uSunScreen.value.set(sunView.x * 0.5 + 0.5, sunView.y * 0.5 + 0.5);
    grade.uniforms.uShafts.value = behind ? 0 : (quality.shafts ?? 0.34);
  };

  return {
    composer,
    bloom,
    update,
    render: () => {
      update();
      composer.render();
    },
    setSize: (width, height) => composer.setSize(width, height),
    dispose: () => composer.dispose(),
  };
}
