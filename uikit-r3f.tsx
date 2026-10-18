import { effect, signal } from "@preact/signals-core";
import {
  applyProps,
  createPortal,
  extend,
  useFrame,
  useStore,
  useThree,
} from "@react-three/fiber/webgpu";
import React, {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import * as THREE from "three/webgpu";
import type { RenderContext } from "./local-uikit/context.ts";
import { reversePainterSortStable } from "./submodules/uikit/packages/uikit/src/order.ts";
import {
  type BoundingBox,
  type ContentProperties as VanillaContentProperties,
} from "./local-uikit/components/content.ts";
import {
  type ContainerProperties as VanillaContainerProperties,
} from "./local-uikit/components/container.ts";
import { Content as VanillaContent } from "./local-uikit/components/content.ts";
import { Container as VanillaContainer } from "./local-uikit/components/container.ts";
import type { EventHandlersProperties as EventHandlers } from "./submodules/uikit/packages/uikit/src/events.ts";
import {
  Fullscreen as VanillaFullscreen,
  type FullscreenProperties as VanillaFullscreenProperties,
} from "./submodules/uikit/packages/uikit/src/components/fullscreen.ts";

type ClassListProperties = { classList?: Array<string | Record<string, unknown>> };

export type ContentProperties = VanillaContentProperties & {
  children?: React.ReactNode;
  boundingBox?: BoundingBox;
  remeasureOnChildrenChange?: boolean;
} & ClassListProperties;

export type ContainerProperties = VanillaContainerProperties & {
  children?: React.ReactNode;
} & ClassListProperties;

export type FullscreenProperties = VanillaFullscreenProperties & {
  children?: React.ReactNode;
  attachCamera?: boolean;
} & ClassListProperties;

extend({ VanillaContainer, VanillaContent, VanillaFullscreen });

function useRenderContext(): RenderContext {
  const invalidate = useThree((state) => state.invalidate);
  return useMemo(() => ({ requestFrame: invalidate }), [invalidate]);
}

function isHandlerKey(key: string): boolean {
  return key.length > 2 && key.startsWith("on") && key[2] >= "A" && key[2] <= "Z";
}

/** Shallow equality, ignoring React children: they never reach the vanilla component. */
function sameProps(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (a === b) return true;
  const keys = Object.keys(a).filter((key) => key !== "children");
  if (keys.length !== Object.keys(b).filter((key) => key !== "children").length) return false;
  return keys.every((key) => Object.is(a[key], b[key]));
}

/**
 * Whether components are being built inside a hidden <Activity>. A hidden Activity builds its
 * subtree without running effects, so props applied only from the effect leave every component
 * unstyled until the first reveal, which then restyles them all in one commit (~55 ms when the
 * window layer was first shown). Under this context, the first render's props are passed to the
 * constructor instead. Visible mounts keep applying them from the effect: moving that work into
 * the commit made it land in a single frame.
 *
 * The value is a stable ref read once at construction, so toggling it re-renders nothing: a
 * changing context value re-rendered every component on each show and hide.
 */
export const ConstructWithPropsContext = createContext<{ readonly current: boolean }>({
  current: false,
});

/**
 * Binds a component's props to what the vanilla component receives: handlers go through stable
 * trampolines, because inline ones are new every render.
 */
function usePropsBinding() {
  const constructWithProps = useContext(ConstructWithPropsContext);
  const binding = useRef<{
    latestHandlers: Record<string, unknown>;
    trampolines: Record<string, (...args: unknown[]) => unknown>;
    constructedWith?: Record<string, unknown>;
  }>({ latestHandlers: {}, trampolines: {} }).current;
  const bind = (inProps: Record<string, unknown>) => {
    const props: Record<string, unknown> = {};
    for (const key in inProps) {
      const value = inProps[key];
      props[key] = isHandlerKey(key) && typeof value === "function"
        ? binding.trampolines[key] ??= (...args) =>
          (binding.latestHandlers[key] as (...args: unknown[]) => unknown)?.(...args)
        : value;
    }
    return props;
  };
  return {
    binding,
    bind,
    /** For the constructor arguments' memo: the props the component is built with, if any. */
    construct: (inProps: Record<string, unknown>) =>
      constructWithProps.current ? binding.constructedWith = bind(inProps) : undefined,
  };
}

type PropsBinding = ReturnType<typeof usePropsBinding>;

function useSetup(
  ref: { current: any },
  inProps: Record<string, unknown>,
  args: Array<unknown>,
  { binding, bind }: PropsBinding,
) {
  useFrame((_, delta) => {
    ref.current?.update(delta * 1000);
  });

  const renderer = useThree((state) => state.gl) as unknown as Record<string, unknown>;

  useEffect(() => {
    if ("localClippingEnabled" in renderer) {
      renderer.localClippingEnabled = true;
    }
    if ("setTransparentSort" in renderer && typeof renderer.setTransparentSort === "function") {
      renderer.setTransparentSort(reversePainterSortStable);
    }
  }, [renderer]);

  // Re-applying properties restyles and relayouts the component, so skip it when nothing changed:
  // revealing a hidden <Activity> re-renders its subtree, which restyled every window for ~0.1 s
  // per show. A component still holding its constructor's props has had those applied.
  const applied = useRef<{ component: unknown; props: Record<string, unknown> } | null>(null);
  useEffect(() => {
    const component = ref.current;
    binding.latestHandlers = inProps;
    const props = bind(inProps);
    const last = applied.current ??
      (component != null && binding.constructedWith != null &&
          component.inputProperties === binding.constructedWith
        ? { component, props: binding.constructedWith }
        : null);
    if (last != null && last.component === component && sameProps(last.props, props)) {
      applied.current = last;
      return;
    }
    component?.resetProperties(props);
    applied.current = { component, props };
  });

  useEffect(() => {
    const classList = inProps.classList;
    const component = ref.current;
    if (!Array.isArray(classList) || component == null) {
      component?.classList.set();
      return;
    }
    component.classList.set(...classList);
  }, [inProps]);

  const outPropsRef = useRef<{ args: Array<unknown> } & EventHandlers>({ args });

  useEffect(() => {
    const component = ref.current;
    if (component == null) {
      return;
    }

    const unsubscribe = effect(() => {
      const handlers = component.handlers.value;
      outPropsRef.current = Object.keys(handlers).length === 0 ? { args } : { args, ...handlers };

      if ((component as { __r3f?: { props: unknown } }).__r3f != null) {
        (component as { __r3f: { props: unknown } }).__r3f.props = outPropsRef.current;
        applyProps(component, outPropsRef.current);
      }
    });

    return () => {
      unsubscribe();
      outPropsRef.current = { args };
      if ((component as { __r3f?: { props: unknown } }).__r3f != null) {
        (component as { __r3f: { props: unknown } }).__r3f.props = outPropsRef.current;
      }
      applyProps(component, outPropsRef.current);
    };
  }, [args]);

  return outPropsRef.current;
}

function buildVanilla<T>(name: string) {
  return forwardRef<T, { children?: React.ReactNode } & Record<string, unknown>>(
    ({ children, ...props }, forwardedRef) => {
      const ref = useRef<any>(null);
      useImperativeHandle(forwardedRef, () => ref.current, []);
      const renderContext = useRenderContext();
      const propsBinding = usePropsBinding();
      const args = useMemo(
        () => [propsBinding.construct(props), undefined, { renderContext }],
        [renderContext],
      );
      const outProps = useSetup(ref, props, args, propsBinding);
      return React.createElement(name, { ref, ...outProps }, children as React.ReactNode);
    },
  );
}

export const Container = buildVanilla<any>("vanillaContainer");

export const Content = forwardRef<any, ContentProperties>(
  ({ children, boundingBox, remeasureOnChildrenChange, ...props }, forwardedRef) => {
    const ref = useRef<any>(null);
    useImperativeHandle(forwardedRef, () => ref.current, []);
    const renderContext = useRenderContext();
    const boundingBoxSignal = useMemo(
      () => (boundingBox == null ? undefined : signal(boundingBox)),
      [boundingBox],
    );
    const propsBinding = usePropsBinding();
    const args = useMemo(
      () => [
        propsBinding.construct(props),
        undefined,
        { renderContext, boundingBox: boundingBoxSignal, remeasureOnChildrenChange },
      ],
      [boundingBoxSignal, remeasureOnChildrenChange, renderContext],
    );
    useEffect(() => {
      if (ref.current != null && ref.current.clippingRect == null) {
        ref.current.clippingRect = signal(undefined);
      }
    }, []);
    const outProps = useSetup(ref, props, args, propsBinding);
    return React.createElement("vanillaContent", { ref, ...outProps }, children);
  },
);

export const Fullscreen = forwardRef<any, FullscreenProperties>(
  ({ children, attachCamera = true, ...props }, forwardedRef) => {
    const attachedRef = useRef(false);
    useFrame(({ camera, scene }) => {
      if (camera.parent == null && attachCamera) {
        scene.add(camera);
        attachedRef.current = true;
      }
    });

    const store = useStore();
    useEffect(() => {
      return () => {
        if (!attachedRef.current) {
          return;
        }
        attachedRef.current = false;
        const current = store.getState();
        if (current.camera.parent === current.scene) {
          current.scene.remove(current.camera);
        }
      };
    }, [store]);

    const camera = useThree((state) => state.camera);
    const wrapper = useMemo(() => new THREE.Object3D(), []);
    wrapper.parent?.remove(wrapper);
    (camera as unknown as THREE.Object3D).add(wrapper as unknown as THREE.Object3D);

    const renderer = useThree((state) => state.gl);
    const renderContext = useRenderContext();
    const ref = useRef<any>(null);
    useImperativeHandle(forwardedRef, () => ref.current, []);
    const propsBinding = usePropsBinding();
    const args = useMemo(
      () => [renderer, propsBinding.construct(props), undefined, { renderContext }],
      [renderer, renderContext],
    );
    const outProps = useSetup(ref, props, args, propsBinding);

    return createPortal(
      React.createElement("vanillaFullscreen", { ref, ...outProps }, children),
      wrapper as any,
    );
  },
);
