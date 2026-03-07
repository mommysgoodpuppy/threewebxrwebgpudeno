import React, { useRef, useState } from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import { XRDevice, metaQuest3 } from "iwer";
import { advance, createRoot, extend, ThreeToJSXElements, useFrame } from "@react-three/fiber";
import { createXRStore, XR, XROrigin } from "@react-three/xr";
import { Content } from "./uikit-r3f.tsx";
import { Button, Container, Text } from "./webgpu-uikit.tsx";

// deno-lint-ignore no-explicit-any
extend(THREE as any);

declare module "@react-three/fiber" {
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

const WIDTH = 1600;
const HEIGHT = 900;
const XR_REFERENCE_SPACE = "local-floor";
const FRAME_STALL_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 16;
const BUILD_OS = Deno.build.os;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

type RafCallback = (time: number) => void;
// deno-lint-ignore no-explicit-any
const globalAny = globalThis as any;

if (!globalAny.requestAnimationFrame) {
  globalAny.requestAnimationFrame = (cb: RafCallback): number => {
    return setTimeout(() => cb(performance.now()), POLL_INTERVAL_MS) as unknown as number;
  };
}

if (!globalAny.cancelAnimationFrame) {
  globalAny.cancelAnimationFrame = (id: number): void => {
    clearTimeout(id as unknown as number);
  };
}

class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalAny.ResizeObserver ??= ResizeObserver;
globalAny.window ??= globalThis as unknown as Window & typeof globalThis;
globalAny.innerWidth = WIDTH;
globalAny.innerHeight = HEIGHT;

if (!globalAny.document) {
  const body = {
    append() {},
    appendChild() {},
    removeChild() {},
  };
  globalAny.document = {
    body,
    createElement: (tag: string) => {
      if (tag === "canvas") {
        return {
          style: {},
          ownerDocument: globalAny.document,
          addEventListener() {},
          removeEventListener() {},
          getContext() {
            return null;
          },
        };
      }
      return {
        style: {},
        append() {},
        appendChild() {},
        remove() {},
        addEventListener() {},
        removeEventListener() {},
      };
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

if (!globalAny.HTMLElement) {
  globalAny.HTMLElement = class HTMLElement {};
}

if (!globalAny.Element) {
  globalAny.Element = class Element {};
}

if (!globalAny.CustomEvent) {
  globalAny.CustomEvent = class CustomEvent<T = unknown> extends Event {
    declare detail: T;

    constructor(type: string, init?: CustomEventInit<T>) {
      super(type, init);
      this.detail = init?.detail as T;
    }
  } as typeof globalThis.CustomEvent;
}

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
    ownerDocument: globalAny.document,
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect() {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        width,
        height,
        right: width,
        bottom: height,
      };
    },
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
    if (view.getUint32() === SDL_QUIT) {
      return true;
    }
  }

  return false;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastFrameAt = performance.now();
let frameCount = 0;
let running = true;

const store = createXRStore({
  offerSession: false,
  enterGrantedSession: false,
  emulate: false,
  domOverlay: false,
  webgpu: "required",
});

function LayersIcon() {
  return (
    <Content width={22} height={22}>
      <mesh position={[0, 0.005, 0.003]}>
        <planeGeometry args={[0.012, 0.0035]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0xffffff)} />
      </mesh>
      <mesh position={[0, 0, 0.003]}>
        <planeGeometry args={[0.012, 0.0035]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0xffffff)} />
      </mesh>
      <mesh position={[0, -0.005, 0.003]}>
        <planeGeometry args={[0.012, 0.0035]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0xffffff)} />
      </mesh>
    </Content>
  );
}

function MusicIcon() {
  return (
    <Content width={22} height={22}>
      <mesh position={[-0.002, 0.002, 0.003]}>
        <planeGeometry args={[0.003, 0.012]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0xffffff)} />
      </mesh>
      <mesh position={[0.0035, 0.0045, 0.003]}>
        <planeGeometry args={[0.009, 0.003]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0xffffff)} />
      </mesh>
      <mesh position={[-0.0045, -0.0055, 0.003]}>
        <circleGeometry args={[0.004, 20]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0xffffff)} />
      </mesh>
      <mesh position={[0.0025, -0.0035, 0.003]}>
        <circleGeometry args={[0.004, 20]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0xffffff)} />
      </mesh>
    </Content>
  );
}

function SignalHighIcon() {
  return (
    <Content width={22} height={22}>
      <mesh position={[-0.005, -0.004, 0.003]}>
        <planeGeometry args={[0.003, 0.005]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0xffffff)} />
      </mesh>
      <mesh position={[0, -0.002, 0.003]}>
        <planeGeometry args={[0.003, 0.009]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0xffffff)} />
      </mesh>
      <mesh position={[0.005, 0.001, 0.003]}>
        <planeGeometry args={[0.003, 0.015]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0xffffff)} />
      </mesh>
    </Content>
  );
}

function MenuHud({ hudRef }: { hudRef: React.RefObject<any> }) {
  const [layersActive, setLayersActive] = useState(false);
  const [musicActive, setMusicActive] = useState(true);
  const [signalActive, setSignalActive] = useState(true);
  const isConnected = true;

  return (
    <Container
      ref={hudRef}
      pixelSize={0.001}
      backgroundColor="#2c3e50"
      borderColor="#3b5268"
      borderWidth={4}
      borderRadius={20}
      backgroundOpacity={0.8}
      padding={10}
      flexDirection="column"
      alignItems="stretch"
      gap={10}
    >
      <Container
        flexDirection="row"
        alignItems="center"
        paddingX={15}
        paddingY={8}
        borderRadius={15}
        backgroundColor="rgba(70, 80, 90)"
        backgroundOpacity={0.7}
      >
        <Container flexDirection="column" flexShrink={0}>
          <Text color="#ffffff" fontSize={28} fontWeight="bold">
            06:35 AM
          </Text>
          <Text color="#bdc3c7" fontSize={14}>
            Tue 16/01/2024
          </Text>
          <Text color="#bdc3c7" fontSize={12}>
            00:03:42
          </Text>
        </Container>

        <Container padding={14} flexGrow={1} />

        <Container flexDirection="row" gap={8} alignItems="center" flexShrink={0}>
          <Button
            padding={24}
            borderRadius={12}
            backgroundColor={layersActive ? "#f6ad2f" : "#f39c12"}
            backgroundOpacity={1}
            onClick={() => setLayersActive((current) => !current)}
            hover={{ backgroundColor: layersActive ? "#ffbf47" : "#d98200", backgroundOpacity: 1 }}
          >
            <LayersIcon />
          </Button>
          <Button
            padding={24}
            borderRadius={12}
            backgroundColor={musicActive ? "#f6ad2f" : "#a51d1d"}
            backgroundOpacity={1}
            onClick={() => setMusicActive((current) => !current)}
            hover={{ backgroundColor: musicActive ? "#ffbf47" : "#c53030", backgroundOpacity: 1 }}
          >
            <MusicIcon />
          </Button>
          <Button
            padding={24}
            borderRadius={12}
            backgroundColor={signalActive ? "#f6ad2f" : "#a51d1d"}
            backgroundOpacity={1}
            onClick={() => setSignalActive((current) => !current)}
            hover={{ backgroundColor: signalActive ? "#ffbf47" : "#c53030", backgroundOpacity: 1 }}
          >
            <SignalHighIcon />
          </Button>
        </Container>
      </Container>

      <Container {...({ positionType: "absolute", left: 10, bottom: 10 } as any)}>
        <Text color={isConnected ? "#90ee90" : "#ff6b6b"} fontSize={12}>
          {isConnected ? "Connected" : "Disconnected"}
        </Text>
      </Container>
    </Container>
  );
}

function Scene() {
  const cubeRef = useRef<THREE.Mesh>(null!);
  const hudRef = useRef<any>(null);
  const cameraForward = new THREE.Vector3();
  const cameraTarget = new THREE.Vector3();

  useFrame((state, _delta, frame) => {
    cubeRef.current.rotation.x += 0.01;
    cubeRef.current.rotation.y += 0.02;
    if (hudRef.current) {
      state.camera.getWorldDirection(cameraForward);
      cameraTarget.copy(state.camera.position).addScaledVector(cameraForward, 0.8);
      hudRef.current.position.copy(cameraTarget);
      hudRef.current.quaternion.copy(state.camera.quaternion);
      hudRef.current.rotation.z = Math.sin(performance.now() * 0.001) * 0.02;
    }
    lastFrameAt = performance.now();
    frameCount++;
    if (frame && (frameCount === 1 || frameCount % 120 === 0)) {
      console.log("Rendered XR frame", frameCount);
    }
  });

  return (
    <XR store={store}>
      <color attach="background" args={[0x101820]} />
      <ambientLight intensity={0.6} />
      <directionalLight intensity={3} position={[2, 4, 1]} />
      <XROrigin />

      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[8, 8]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0x2a2a2a)} />
      </mesh>

      <mesh ref={cubeRef} position={[0, 1.6, -2]}>
        <boxGeometry args={[0.4, 0.4, 0.4]} />
        <meshBasicNodeMaterial colorNode={TSL.color(0x44aa88)} />
      </mesh>

      <MenuHud hudRef={hudRef} />
    </XR>
  );
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

const { window, metalView } = createWindow("Deno + R3F + WebXR + WebGPU", WIDTH, HEIGHT);
const surface = createSurface(window, metalView, WIDTH, HEIGHT);
surface.resize(WIDTH, HEIGHT);
const { canvas, context } = makeCanvas(surface, WIDTH, HEIGHT);
context.configure({
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
    context,
    device,
    format: preferredFormat,
    present: () => surface.present(),
  },
});
xrDevice.installRuntime({ globalObject: globalThis, polyfillLayers: false });
assert(navigator.xr, "navigator.xr was not installed");

const root = createRoot(canvas);
let renderer: THREE.WebGPURenderer | undefined;

await root.configure({
  gl: (async (props: Record<string, unknown>) => {
    console.log("Creating WebGPURenderer");
    const nextRenderer = new THREE.WebGPURenderer({
      ...props,
      canvas,
      context,
      device,
      antialias: false,
      alpha: false,
    });
    nextRenderer.xr.enabled = true;
    nextRenderer.xr.setReferenceSpaceType(XR_REFERENCE_SPACE);
    nextRenderer.setSize(WIDTH, HEIGHT);
    await nextRenderer.init();
    renderer = nextRenderer;
    return nextRenderer;
  }) as never,
  size: { width: WIDTH, height: HEIGHT, top: 0, left: 0 },
  dpr: 1,
  frameloop: "never",
  camera: { position: [0, 1.6, 0], fov: 75, near: 0.1, far: 100 },
});

const rootStore = root.render(<Scene />);
// Fiber's built-in XR session switching assumes WebGL XR manager semantics.
// We drive the WebGPU XR frame loop ourselves below.
rootStore.getState().xr.disconnect();
await wait(0);
advance(performance.now(), true, rootStore.getState());
surface.present();

await renderer?.setAnimationLoop((time: number, frame?: XRFrame) => {
  if (!frame) {
    return;
  }
  advance(time, true, rootStore.getState(), frame);
  lastFrameAt = performance.now();
  frameCount++;
  if (frameCount === 1 || frameCount % 120 === 0) {
    console.log("Rendered XR frame", frameCount);
  }
});

console.log("Requesting immersive VR session");
const session = await store.enterVR();
assert(session, "Failed to enter immersive VR session");
let xrEnded = false;
session.addEventListener("end", () => {
  xrEnded = true;
});
assert(renderer?.xr.isPresenting, "Three.js XR manager failed to enter presenting state");

while (running) {
  if (pollSdlQuit()) {
    console.log("SDL_QUIT received");
    running = false;
    break;
  }

  if (!xrEnded && renderer?.xr.isPresenting && performance.now() - lastFrameAt > FRAME_STALL_TIMEOUT_MS) {
    throw new Error(`XR animation stalled for more than ${FRAME_STALL_TIMEOUT_MS} ms`);
  }

  await wait(POLL_INTERVAL_MS);
}

if (!xrEnded) {
  console.log("Ending XR session");
  await session.end();
}

store.destroy();
root.unmount();
await renderer?.setAnimationLoop(null);
renderer?.dispose();
sdl2.symbols.SDL_DestroyWindow(window);
sdl2.symbols.SDL_Quit();
console.log("Shutdown complete");
