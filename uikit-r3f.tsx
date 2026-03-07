import { effect, signal } from "@preact/signals-core";
import {
  applyProps,
  createPortal,
  extend,
  useFrame,
  useStore,
  useThree,
} from "@react-three/fiber";
import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
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

function useSetup(ref: { current: any }, inProps: Record<string, unknown>, args: Array<unknown>) {
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

  useEffect(() => {
    ref.current?.resetProperties(inProps);
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
  return forwardRef<T, { children?: React.ReactNode } & Record<string, unknown>>(({ children, ...props }, forwardedRef) => {
    const ref = useRef<any>(null);
    useImperativeHandle(forwardedRef, () => ref.current, []);
    const renderContext = useRenderContext();
    const args = useMemo(() => [undefined, undefined, { renderContext }], [renderContext]);
    const outProps = useSetup(ref, props, args);
    return React.createElement(name, { ref, ...outProps }, children as React.ReactNode);
  });
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
    const args = useMemo(
      () => [
        undefined,
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
    const outProps = useSetup(ref, props, args);
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
    const args = useMemo(
      () => [renderer, undefined, undefined, { renderContext }],
      [renderer, renderContext],
    );
    const outProps = useSetup(ref, props, args);

    return createPortal(
      React.createElement("vanillaFullscreen", { ref, ...outProps }, children),
      wrapper as any,
    );
  },
);
