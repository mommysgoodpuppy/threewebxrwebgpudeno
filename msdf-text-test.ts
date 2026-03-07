import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import { PNG } from "npm:pngjs";
import MSDFTextGeometry from "./submodules/three-msdf-text-utils/src/MSDFTextGeometry/index.js";
import MSDFTextNodeMaterial from "./submodules/three-msdf-text-utils/src/MSDFTextNodeMaterial/index.js";

const WIDTH = 1280;
const HEIGHT = 720;
const POLL_INTERVAL_MS = 16;
const BUILD_OS = Deno.build.os;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

type RafCallback = (time: number) => void;
// deno-lint-ignore no-explicit-any
const globalAny = globalThis as any;

globalAny.window ??= globalThis as unknown as Window & typeof globalThis;
globalAny.document ??= {
  body: {
    append() {},
    appendChild() {},
    removeChild() {},
  },
  createElement: () => ({
    style: {},
    addEventListener() {},
    removeEventListener() {},
    getContext() {
      return null;
    },
  }),
};
globalAny.ResizeObserver ??= ResizeObserver;
globalAny.innerWidth = WIDTH;
globalAny.innerHeight = HEIGHT;
globalAny.requestAnimationFrame ??= ((cb: RafCallback) =>
  setTimeout(() => cb(performance.now()), POLL_INTERVAL_MS)) as typeof requestAnimationFrame;
globalAny.cancelAnimationFrame ??= ((id: number) => clearTimeout(id)) as typeof cancelAnimationFrame;

console.log("Loading SDL2 library");
const sdl2 = Deno.dlopen("SDL2", {
  SDL_Init: { parameters: ["u32"], result: "i32" },
  SDL_Quit: { parameters: [], result: "void" },
  SDL_CreateWindow: {
    parameters: ["buffer", "i32", "i32", "i32", "i32", "u32"],
    result: "pointer",
  },
  SDL_DestroyWindow: { parameters: ["pointer"], result: "void" },
  SDL_GetWindowWMInfo: { parameters: ["pointer", "pointer"], result: "i32" },
  SDL_GetVersion: { parameters: ["pointer"], result: "void" },
  SDL_PollEvent: { parameters: ["pointer"], result: "i32" },
  SDL_Metal_CreateView: { parameters: ["pointer"], result: "pointer" },
});

const enc = new TextEncoder();
const SDL_INIT_VIDEO = 0x00000020;
const SDL_WINDOW_SHOWN = 0x00000004;
const SDL_WINDOW_RESIZABLE = 0x00000020;
const SDL_QUIT = 0x100;
const sizeOfEvent = 56;
const eventBuf = new Uint8Array(sizeOfEvent);
const sizeOfSDL_SysWMInfo = 3 + 4 + 8 * 64;
const wmInfoBuf = new Uint8Array(sizeOfSDL_SysWMInfo);

function asCString(text: string): Uint8Array {
  return enc.encode(`${text}\0`);
}

function createWindow(title: string, width: number, height: number) {
  const raw = sdl2.symbols.SDL_CreateWindow(
    asCString(title) as BufferSource,
    0x2fff0000,
    0x2fff0000,
    width,
    height,
    SDL_WINDOW_SHOWN | SDL_WINDOW_RESIZABLE,
  );
  assert(raw !== null, "SDL_CreateWindow failed");
  const metalView = BUILD_OS === "darwin" ? sdl2.symbols.SDL_Metal_CreateView(raw) : null;
  return { window: raw, metalView };
}

function createSurface(
  window: Deno.PointerValue,
  metalView: Deno.PointerValue | null,
  width: number,
  height: number,
): Deno.UnsafeWindowSurface {
  const wmInfo = Deno.UnsafePointer.of(wmInfoBuf);
  assert(wmInfo, "Failed to obtain pointer for SDL_SysWMInfo");
  sdl2.symbols.SDL_GetVersion(wmInfo);
  const ok = sdl2.symbols.SDL_GetWindowWMInfo(window, wmInfo);
  assert(ok !== 0, "SDL_GetWindowWMInfo failed");

  const view = new Deno.UnsafePointerView(wmInfo);
  const subsystem = view.getUint32(4);

  if (BUILD_OS === "darwin") {
    const nsView = view.getPointer(8);
    assert(nsView, "Missing Cocoa NSView pointer");
    return new Deno.UnsafeWindowSurface({
      system: "cocoa",
      windowHandle: nsView,
      displayHandle: metalView,
      width,
      height,
    });
  }

  if (BUILD_OS === "windows") {
    const hwnd = view.getPointer(8);
    const hinstance = view.getPointer(28);
    assert(subsystem === 1, `Unexpected Windows SDL subsystem ${subsystem}`);
    assert(hwnd, "Missing Win32 HWND");
    assert(hinstance, "Missing Win32 HINSTANCE");
    return new Deno.UnsafeWindowSurface({
      system: "win32",
      windowHandle: hwnd,
      displayHandle: hinstance,
      width,
      height,
    });
  }

  if (BUILD_OS === "linux") {
    const display = view.getPointer(8);
    const surface = view.getPointer(16);
    assert(display, "Missing Linux display handle");
    assert(surface, "Missing Linux window handle");
    if (subsystem === 2) {
      return new Deno.UnsafeWindowSurface({
        system: "x11",
        windowHandle: surface,
        displayHandle: display,
        width,
        height,
      });
    }
    if (subsystem === 6) {
      return new Deno.UnsafeWindowSurface({
        system: "wayland",
        windowHandle: surface,
        displayHandle: display,
        width,
        height,
      });
    }
  }

  throw new Error(`Unsupported platform ${BUILD_OS}`);
}

function pollSdlQuit(): boolean {
  const event = Deno.UnsafePointer.of(eventBuf);
  assert(event, "Failed to obtain SDL event pointer");

  while (sdl2.symbols.SDL_PollEvent(event) === 1) {
    const view = new Deno.UnsafePointerView(event);
    if (view.getUint32() === SDL_QUIT) {
      return true;
    }
  }

  return false;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadFontAssets() {
  const fontPath = "C:/GIT/threewebxrwebgpudeno/submodules/three-msdf-text-utils/demo/fonts/roboto/roboto-regular.fnt";
  const atlasPath = "C:/GIT/threewebxrwebgpudeno/submodules/three-msdf-text-utils/demo/fonts/roboto/roboto-regular.png";

  const [fontText, atlasBytes] = await Promise.all([
    Deno.readTextFile(fontPath),
    Deno.readFile(atlasPath),
  ]);

  const font = JSON.parse(fontText);
  const png = PNG.sync.read(Buffer.from(atlasBytes));
  const atlas = new THREE.DataTexture(
    new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength),
    png.width,
    png.height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  atlas.flipY = true;
  atlas.generateMipmaps = false;
  atlas.minFilter = THREE.LinearFilter;
  atlas.magFilter = THREE.LinearFilter;
  atlas.needsUpdate = true;

  return { font, atlas };
}

console.log("Initializing SDL2 video subsystem");
assert(sdl2.symbols.SDL_Init(SDL_INIT_VIDEO) === 0, "SDL_Init failed");

console.log("Requesting WebGPU adapter");
const adapter = await navigator.gpu.requestAdapter();
assert(adapter, "No WebGPU adapter available");

console.log("Requesting WebGPU device");
const device = await adapter.requestDevice();
const preferredFormat = navigator.gpu.getPreferredCanvasFormat();

const { window, metalView } = createWindow("MSDF Text Test", WIDTH, HEIGHT);
const surface = createSurface(window, metalView, WIDTH, HEIGHT);
surface.resize(WIDTH, HEIGHT);
const context = surface.getContext("webgpu");
assert(context, "Failed to obtain GPUCanvasContext");
context.configure({
  device,
  format: preferredFormat,
  alphaMode: "opaque",
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
});

console.log("Loading font assets");
const { font, atlas } = await loadFontAssets();
console.log("Font loaded", { lineHeight: font.common?.lineHeight, chars: font.chars?.length });

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101820);

const camera = new THREE.PerspectiveCamera(50, WIDTH / HEIGHT, 0.1, 100);
camera.position.set(0, 0, 6);

const renderer = new THREE.WebGPURenderer({
  canvas: {
    width: WIDTH,
    height: HEIGHT,
    style: { width: `${WIDTH}px`, height: `${HEIGHT}px` },
    ownerDocument: globalAny.document,
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect() {
      return { x: 0, y: 0, top: 0, left: 0, width: WIDTH, height: HEIGHT, right: WIDTH, bottom: HEIGHT };
    },
    getContext(type: string) {
      return type === "webgpu" ? context : null;
    },
  } as HTMLCanvasElement,
  context,
  device,
  antialias: false,
  alpha: false,
});
renderer.setSize(WIDTH, HEIGHT);
await renderer.init();

scene.add(new THREE.AmbientLight(0xffffff, 1));

const background = new THREE.Mesh(
  new THREE.PlaneGeometry(4.8, 1.6),
  new THREE.MeshBasicNodeMaterial({ colorNode: TSL.color(0x2c3e50) }),
);
background.position.set(0, 0, -0.1);
scene.add(background);

const geometry = new MSDFTextGeometry({
  text: "WEBGPU MSDF TEXT",
  font,
  align: "center",
});
console.log("Geometry layout", {
  width: geometry.layout?.width,
  height: geometry.layout?.height,
  glyphs: geometry.visibleGlyphs?.length,
});

const material = new MSDFTextNodeMaterial({
  map: atlas,
  color: "#ffffff",
  opacity: 1,
});
material.side = THREE.DoubleSide;
material.transparent = true;
material.alphaTest = 0.01;
material.depthWrite = false;
material.depthTest = false;

const text = new THREE.Mesh(geometry, material);
const scale = 0.01;
text.rotation.x = Math.PI;
text.scale.set(scale, scale, scale);
text.position.set(-(geometry.layout?.width ?? 0) * scale * 0.5, 0.2, 0);
scene.add(text);

const marker = new THREE.Mesh(
  new THREE.BoxGeometry(0.05, 0.05, 0.05),
  new THREE.MeshBasicNodeMaterial({ colorNode: TSL.color(0xff0000) }),
);
marker.position.copy(text.position);
scene.add(marker);

const atlasPreview = new THREE.Mesh(
  new THREE.PlaneGeometry(1.5, 1.5),
  new THREE.MeshBasicMaterial({ map: atlas }),
);
atlasPreview.position.set(2.2, 0, 0);
scene.add(atlasPreview);

let running = true;
let frameCount = 0;
while (running) {
  if (pollSdlQuit()) {
    running = false;
    break;
  }

  text.rotation.z = Math.sin(performance.now() * 0.001) * 0.03;
  await renderer.renderAsync(scene, camera);
  surface.present();

  frameCount++;
  if (frameCount === 1 || frameCount % 120 === 0) {
    console.log("Rendered frame", frameCount);
  }

  await wait(POLL_INTERVAL_MS);
}

geometry.dispose();
renderer.dispose();
sdl2.symbols.SDL_DestroyWindow(window);
sdl2.symbols.SDL_Quit();
console.log("Shutdown complete");
