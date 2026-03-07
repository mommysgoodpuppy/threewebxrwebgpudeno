// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import { BoxLineGeometry } from "./submodules/three.js/examples/jsm/geometries/BoxLineGeometry.js";
import { XRControllerModelFactory } from "./submodules/three.js/examples/jsm/webxr/XRControllerModelFactory.js";
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
  renderer.render(scene, camera);
  surface.present();
}

type RafCallback = (time: number) => void;
type IntersectableCube = THREE.Mesh & {
  currentHex?: number;
  userData: {
    velocity: THREE.Vector3;
  };
};

const globalAny = globalThis as typeof globalThis & {
  requestAnimationFrame?: (cb: RafCallback) => number;
  cancelAnimationFrame?: (id: number) => void;
  window?: Window & typeof globalThis;
  innerWidth?: number;
  innerHeight?: number;
  devicePixelRatio?: number;
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

globalAny.window ??= globalThis as unknown as Window & typeof globalThis;
globalAny.innerWidth = WIDTH;
globalAny.innerHeight = HEIGHT;
globalAny.devicePixelRatio = 1;

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

function buildController(data: XRInputSource): THREE.Object3D {
  switch (data.targetRayMode) {
    case "tracked-pointer": {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, -1], 3),
      );
      geometry.setAttribute(
        "color",
        new THREE.Float32BufferAttribute([0.5, 0.5, 0.5, 0, 0, 0], 3),
      );
      const material = new THREE.LineBasicMaterial({
        vertexColors: true,
        blending: THREE.AdditiveBlending,
      });
      return new THREE.Line(geometry, material);
    }
    case "gaze": {
      const geometry = new THREE.RingGeometry(0.02, 0.04, 32).translate(0, 0, -1);
      const material = new THREE.MeshBasicMaterial({ opacity: 0.5, transparent: true });
      return new THREE.Mesh(geometry, material);
    }
    default:
      throw new Error(`Unsupported targetRayMode: ${data.targetRayMode}`);
  }
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

const { window, metalView } = createWindow("Deno + three.js webgpu_xr_cubes", WIDTH, HEIGHT);
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

const clock = new THREE.Clock();
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x505050);

const camera = new THREE.PerspectiveCamera(50, WIDTH / HEIGHT, 0.1, 10);
camera.position.set(0, 1.6, 3);
scene.add(camera);

const room = new THREE.LineSegments(
  new BoxLineGeometry(6, 6, 6, 10, 10, 10).translate(0, 3, 0) as unknown as THREE.BufferGeometry,
  new THREE.LineBasicMaterial({ color: 0xbcbcbc }),
);
scene.add(room);

scene.add(new THREE.HemisphereLight(0xa5a5a5, 0x898989, 3));

const light = new THREE.DirectionalLight(0xffffff, 3);
light.position.set(1, 1, 1).normalize();
scene.add(light);

const geometry = new THREE.BoxGeometry(0.15, 0.15, 0.15);

for (let i = 0; i < 200; i++) {
  const object = new THREE.Mesh(
    geometry,
    new THREE.MeshLambertMaterial({ color: Math.random() * 0xffffff }),
  );

  object.position.x = Math.random() * 4 - 2;
  object.position.y = Math.random() * 4;
  object.position.z = Math.random() * 4 - 2;
  object.rotation.x = Math.random() * 2 * Math.PI;
  object.rotation.y = Math.random() * 2 * Math.PI;
  object.rotation.z = Math.random() * 2 * Math.PI;
  object.scale.x = Math.random() + 0.5;
  object.scale.y = Math.random() + 0.5;
  object.scale.z = Math.random() + 0.5;
  object.userData.velocity = new THREE.Vector3(
    Math.random() * 0.01 - 0.005,
    Math.random() * 0.01 - 0.005,
    Math.random() * 0.01 - 0.005,
  );

  room.add(object);
}

const raycaster = new THREE.Raycaster();

console.log("Creating WebGPURenderer");
const renderer = new THREE.WebGPURenderer({
  canvas,
  context: canvasContext,
  device,
  antialias: false,
  alpha: false,
  outputBufferType: THREE.UnsignedByteType,
  multiview: true,
});
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType(XR_REFERENCE_SPACE);
renderer.setPixelRatio(1);
renderer.setSize(WIDTH, HEIGHT);
await renderer.init();

let intersected: IntersectableCube | undefined;

function onSelectStart(this: THREE.Group) {
  this.userData.isSelecting = true;
}

function onSelectEnd(this: THREE.Group) {
  this.userData.isSelecting = false;
}

const controller = renderer.xr.getController(0);
controller.addEventListener("selectstart", onSelectStart);
controller.addEventListener("selectend", onSelectEnd);
controller.addEventListener("connected", function (
  this: THREE.Group,
  event: { data?: XRInputSource },
) {
  const inputSource = event.data;
  assert(inputSource, "Controller connected event missing XRInputSource");
  if (inputSource.targetRayMode === "tracked-pointer" || inputSource.targetRayMode === "gaze") {
    this.add(buildController(inputSource));
  }
});
controller.addEventListener("disconnected", function (this: THREE.Group) {
  if (this.children[0]) {
    this.remove(this.children[0]);
  }
});
scene.add(controller);

const controllerModelFactory = new XRControllerModelFactory();
const controllerGrip = renderer.xr.getControllerGrip(0);
controllerGrip.add(
  controllerModelFactory.createControllerModel(controllerGrip) as unknown as THREE.Object3D,
);
scene.add(controllerGrip);

await warmupIwerWebGPUXR(renderer, scene, camera, surface);

function animate() {
  const delta = clock.getDelta() * 60;

  if (controller.userData.isSelecting === true && room.children.length > 0) {
    const cube = room.children[0] as IntersectableCube;
    room.remove(cube);
    cube.position.copy(controller.position);
    cube.userData.velocity.x = (Math.random() - 0.5) * 0.02 * delta;
    cube.userData.velocity.y = (Math.random() - 0.5) * 0.02 * delta;
    cube.userData.velocity.z = (Math.random() * 0.01 - 0.05) * delta;
    cube.userData.velocity.applyQuaternion(controller.quaternion);
    room.add(cube);
  }

  raycaster.setFromXRController(controller);
  const intersects = raycaster.intersectObjects(room.children, false);

  if (intersects.length > 0) {
    if (intersected !== intersects[0].object) {
      if (intersected) {
        (intersected.material as THREE.MeshLambertMaterial).emissive.setHex(
          intersected.currentHex ?? 0x000000,
        );
      }

      intersected = intersects[0].object as IntersectableCube;
      const material = intersected.material as THREE.MeshLambertMaterial;
      intersected.currentHex = material.emissive.getHex();
      material.emissive.setHex(0xff0000);
    }
  } else if (intersected) {
    const material = intersected.material as THREE.MeshLambertMaterial;
    material.emissive.setHex(intersected.currentHex ?? 0x000000);
    intersected = undefined;
  }

  for (let i = 0; i < room.children.length; i++) {
    const cube = room.children[i] as IntersectableCube;

    cube.userData.velocity.multiplyScalar(1 - (0.001 * delta));
    cube.position.add(cube.userData.velocity);

    if (cube.position.x < -3 || cube.position.x > 3) {
      cube.position.x = THREE.MathUtils.clamp(cube.position.x, -3, 3);
      cube.userData.velocity.x = -cube.userData.velocity.x;
    }

    if (cube.position.y < 0 || cube.position.y > 6) {
      cube.position.y = THREE.MathUtils.clamp(cube.position.y, 0, 6);
      cube.userData.velocity.y = -cube.userData.velocity.y;
    }

    if (cube.position.z < -3 || cube.position.z > 3) {
      cube.position.z = THREE.MathUtils.clamp(cube.position.z, -3, 3);
      cube.userData.velocity.z = -cube.userData.velocity.z;
    }

    cube.rotation.x += cube.userData.velocity.x * 2 * delta;
    cube.rotation.y += cube.userData.velocity.y * 2 * delta;
    cube.rotation.z += cube.userData.velocity.z * 2 * delta;
  }

  renderer.render(scene, camera);
}

let frameCount = 0;
let lastFrameAt = performance.now();
let xrEnded = false;

await renderer.setAnimationLoop((_time: number, frame?: unknown) => {
  assert(frame, "XR animation loop callback did not receive an XRFrame");
  animate();
  lastFrameAt = performance.now();
  frameCount++;
  if (frameCount === 1 || frameCount % 120 === 0) {
    console.log("Rendered XR cubes frame", frameCount);
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
