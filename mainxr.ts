// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import { XRDevice, metaQuest3 } from "iwer";

const WIDTH = 1600;
const HEIGHT = 900;
const XR_REFERENCE_SPACE = "local-floor";
const FRAME_STALL_TIMEOUT_MS = 5000;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function warmupIwerWebGPUXR(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  surface: Deno.UnsafeWindowSurface,
): Promise<void> {
  // iwer's WebGPU XR path currently requires one completed non-XR render pass
  // before the first XR session frame. Lighter-weight operations like
  // compileAsync() or getCurrentTexture() are not sufficient.
  renderer.render(scene, camera);
  surface.present();
}

type RafCallback = (time: number) => void;
const globalAny = globalThis as typeof globalThis & {
  requestAnimationFrame?: (cb: RafCallback) => number;
  cancelAnimationFrame?: (id: number) => void;
  window?: typeof globalThis;
  innerWidth?: number;
  innerHeight?: number;
};

if (!globalAny.requestAnimationFrame) {
  globalAny.requestAnimationFrame = (cb: RafCallback): number => {
    return setTimeout(() => cb(performance.now()), 16) as unknown as number;
  };
}

if (!globalAny.cancelAnimationFrame) {
  globalAny.cancelAnimationFrame = (id: number): void => {
    clearTimeout(id as unknown as number);
  };
}

globalAny.window ??= globalThis as unknown as Window & typeof globalThis; // yes sir
globalAny.innerWidth = WIDTH;
globalAny.innerHeight = HEIGHT;

const BUILD_OS = Deno.build.os;

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
    const SDL_SYSWM_COCOA = 4;
    const nsView = view.getPointer(8);
    assert(subsystem === SDL_SYSWM_COCOA, "Expected SDL_SYSWM_COCOA on macOS");
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
    const SDL_SYSWM_WINDOWS = 1;
    const SDL_SYSWM_WINRT = 8;
    const hwnd = view.getPointer(8);
    assert(hwnd, "Missing Win32 HWND");
    if (subsystem === SDL_SYSWM_WINDOWS) {
      const hinstance = view.getPointer(28);
      assert(hinstance, "Missing Win32 HINSTANCE");
      return new Deno.UnsafeWindowSurface({
        system: "win32",
        windowHandle: hwnd,
        displayHandle: hinstance,
        width,
        height,
      });
    }
    assert(subsystem !== SDL_SYSWM_WINRT, "WinRT is not supported");
    throw new Error(`Unexpected Windows SDL subsystem ${subsystem}`);
  }

  if (BUILD_OS === "linux") {
    const SDL_SYSWM_X11 = 2;
    const SDL_SYSWM_WAYLAND = 6;
    const display = view.getPointer(8);
    const surface = view.getPointer(16);
    assert(display, "Missing Linux display handle");
    assert(surface, "Missing Linux window handle");
    if (subsystem === SDL_SYSWM_X11) {
      return new Deno.UnsafeWindowSurface({
        system: "x11",
        windowHandle: surface,
        displayHandle: display,
        width,
        height,
      });
    }
    if (subsystem === SDL_SYSWM_WAYLAND) {
      return new Deno.UnsafeWindowSurface({
        system: "wayland",
        windowHandle: surface,
        displayHandle: display,
        width,
        height,
      });
    }
    throw new Error(`Unexpected Linux SDL subsystem ${subsystem}`);
  }

  throw new Error(`Unsupported platform ${BUILD_OS}`);
}

function makeCanvas(surface: Deno.UnsafeWindowSurface, width: number, height: number) {
  const context = surface.getContext("webgpu");
  assert(context, "Failed to obtain GPUCanvasContext from UnsafeWindowSurface");

  const canvas = {
    width,
    height,
    style: { width: `${width}px`, height: `${height}px` },
    addEventListener() {},
    removeEventListener() {},
    getContext(type: string) {
      if (type !== "webgpu") {
        return null;
      }
      return context;
    },
  };

  return { canvas, context };
}

function pollSdlQuit(): boolean {
  const event = Deno.UnsafePointer.of(eventBuf);
  assert(event, "Failed to obtain SDL event pointer");

  while (sdl2.symbols.SDL_PollEvent(event) === 1) {
    const view = new Deno.UnsafePointerView(event);
    const type = view.getUint32();
    if (type === SDL_QUIT) {
      return true;
    }
  }

  return false;
}

console.log("Initializing SDL2 video subsystem");
assert(sdl2.symbols.SDL_Init(SDL_INIT_VIDEO) === 0, "SDL_Init failed");

console.log("Requesting WebGPU adapter");
const adapter = await navigator.gpu.requestAdapter();
assert(adapter, "No WebGPU adapter available");

console.log("Requesting WebGPU device");
const device = await adapter.requestDevice();
const preferredFormat = navigator.gpu.getPreferredCanvasFormat();
device.addEventListener("uncapturederror", (event: Event) => {
  const gpuEvent = event as Event & { error?: { message?: string } };
  throw new Error(`Uncaptured WebGPU error: ${gpuEvent.error?.message ?? "unknown"}`);
});

const { window, metalView } = createWindow("Deno + Three.js + WebXR + WebGPU", WIDTH, HEIGHT);
const surface = createSurface(window, metalView, WIDTH, HEIGHT);
surface.resize(WIDTH, HEIGHT);
const { canvas, context: canvasContext } = makeCanvas(surface, WIDTH, HEIGHT);
canvasContext.configure({
  device,
  format: preferredFormat,
  alphaMode: "opaque",
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
});

console.log("Installing iwer runtime");
const xrDevice = new XRDevice(metaQuest3, {
  stereoEnabled: true,
  webgpu: {
    canvas,
    context: canvasContext,
    device,
    format: preferredFormat,
    present: () => surface.present(),
  },
});
xrDevice.installRuntime({ globalObject: globalThis, polyfillLayers: false });
assert(navigator.xr, "navigator.xr was not installed");

console.log("Creating scene");
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101820);

const camera = new THREE.PerspectiveCamera(75, WIDTH / HEIGHT, 0.1, 100);
camera.position.set(0, 1.6, 0);

const light = new THREE.DirectionalLight(0xffffff, 3);
light.position.set(2, 4, 1);
scene.add(light);
scene.add(new THREE.AmbientLight(0xffffff, 0.6));

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(8, 8),
  new THREE.MeshBasicMaterial({ color: 0x2a2a2a }),
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(0.4, 0.4, 0.4),
  new THREE.MeshBasicMaterial({ color: 0x44aa88 }),
);
cube.position.set(0, 1.6, -2);
scene.add(cube);

console.log("Creating WebGPURenderer");
const renderer = new THREE.WebGPURenderer({
  canvas,
  context: canvasContext,
  device,
  antialias: false,
  alpha: false,
});
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType(XR_REFERENCE_SPACE);
renderer.setSize(WIDTH, HEIGHT);
await renderer.init();
await warmupIwerWebGPUXR(renderer, scene, camera, surface);

let frameCount = 0;
let lastFrameAt = performance.now();
let xrEnded = false;

await renderer.setAnimationLoop((_time: number, frame?: unknown) => {
  assert(frame, "XR animation loop callback did not receive an XRFrame");
  cube.rotation.x += 0.01;
  cube.rotation.y += 0.02;
  renderer.render(scene, camera);
  lastFrameAt = performance.now();
  frameCount++;
  if (frameCount === 1 || frameCount % 120 === 0) {
    console.log("Rendered XR frame", frameCount);
  }
});

console.log("Requesting immersive VR session");
const session = await navigator.xr.requestSession("immersive-vr", {
  requiredFeatures: [XR_REFERENCE_SPACE, "webgpu"],
  optionalFeatures: ["layers"],
});
session.addEventListener("end", () => {
  xrEnded = true;
});

console.log("Binding session to Three.js XR manager");
await renderer.xr.setSession(session);
assert(renderer.xr.isPresenting, "Three.js XR manager failed to enter presenting state");

let running = true;
while (running) {
  if (pollSdlQuit()) {
    console.log("SDL_QUIT received");
    running = false;
    break;
  }

  if (!xrEnded && performance.now() - lastFrameAt > FRAME_STALL_TIMEOUT_MS) {
    throw new Error(`XR animation stalled for more than ${FRAME_STALL_TIMEOUT_MS} ms`);
  }

  await new Promise((resolve) => setTimeout(resolve, 16));
}

if (!xrEnded) {
  console.log("Ending XR session");
  await session.end();
}

await renderer.setAnimationLoop(null);
renderer.dispose();
sdl2.symbols.SDL_DestroyWindow(window);
sdl2.symbols.SDL_Quit();
console.log("Shutdown complete");
