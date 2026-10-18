import React, { forwardRef, useContext, useEffect, useState } from "react";
import * as THREE from "three/webgpu";
import {
  Container as UIKitContainer,
  type ContainerProperties as UIKitContainerProperties,
  ConstructWithPropsContext,
  Content,
} from "./uikit-r3f.tsx";
import {
  DEFAULT_MSDF_FONT,
  measureMsdfText,
  measureMsdfTextNow,
  type MsdfFontId,
  MsdfText,
} from "./msdf-text.tsx";

type ColorValue = string | number;

export type ContainerProps = UIKitContainerProperties & {
  children?: React.ReactNode;
  backgroundOpacity?: number;
};

/**
 * `backgroundOpacity` is passed through to uikit rather than aliased onto
 * `opacity`. They are different properties: `opacity` scales the whole element
 * *including its border and its children*, so an outline-only element —
 * transparent fill, visible border — rendered as nothing at all when
 * `backgroundOpacity={0}` was mapped onto it.
 */
export const Container = forwardRef<any, ContainerProps>(
  ({ backgroundOpacity, ...props }, forwardedRef) => {
    return (
      <UIKitContainer ref={forwardedRef} backgroundOpacity={backgroundOpacity} {...props} />
    );
  },
);

type TextProps = Omit<UIKitContainerProperties, "children" | "width" | "height" | "color"> & {
  children: React.ReactNode;
  color?: ColorValue;
  fontSize?: number;
  fontWeight?: string | number;
  pixelSize?: number;
  textAlign?: "left" | "center" | "right";
  /** Which MSDF atlas to draw from. Icons are just a different font. */
  font?: MsdfFontId;
};

export const Text = forwardRef<any, TextProps>(function Text({
  children,
  color = "#ffffff",
  fontSize = 16,
  fontWeight: _fontWeight,
  pixelSize = 0.001,
  textAlign = "left",
  font = DEFAULT_MSDF_FONT,
  ...props
}: TextProps, forwardedRef) {
  const text = String(children ?? "");
  const key = `${font}\u0000${fontSize}\u0000${textAlign}\u0000${text}`;
  // Built hidden, measure now if the font has loaded: a hidden <Activity> runs no effects, so the
  // text was laid out at the estimate below and relaid out on reveal. Visible mounts keep
  // measuring in the effect, which leaves that work to a later frame.
  const constructWithProps = useContext(ConstructWithPropsContext);
  const [measured, setMeasured] = useState<{
    key: string;
    metrics: {
      width: number;
      height: number;
      bounds: { minX: number; maxX: number; minY: number; maxY: number };
      scale: number;
    };
  }>(() => {
    const now = constructWithProps.current
      ? measureMsdfTextNow(text, fontSize, undefined, textAlign, font)
      : undefined;
    return now ? { key, metrics: now } : {
      key: "",
      metrics: {
        width: Math.max(1, text.length * fontSize * 0.6),
        height: fontSize,
        bounds: { minX: 0, maxX: fontSize, minY: -fontSize, maxY: 0 },
        scale: fontSize / 84,
      },
    };
  });
  const metrics = measured.metrics;
  const measuredKey = measured.key;

  useEffect(() => {
    if (measuredKey === key) return;
    let cancelled = false;
    measureMsdfText(text, fontSize, undefined, textAlign, font).then((nextMetrics) => {
      if (!cancelled) {
        setMeasured({ key, metrics: nextMetrics });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [font, fontSize, key, measuredKey, text, textAlign]);

  const width = Math.max(1, Math.ceil(metrics.width));
  const height = Math.max(1, Math.ceil(metrics.height));
  const worldScale = metrics.scale * pixelSize;
  const worldWidth = width * pixelSize;
  const worldHeight = height * pixelSize;
  const textPosition: [number, number, number] = [
    -worldWidth * 0.5 - metrics.bounds.minX * worldScale,
    worldHeight * 0.5 - metrics.bounds.maxY * worldScale,
    0.001,
  ];

  return (
    <Content width={width} height={height} flexShrink={0} {...props}>
      <MsdfText
        ref={forwardedRef}
        text={text}
        font={font}
        color={color}
        fontSize={worldScale}
        align={textAlign}
        position={textPosition}
      />
    </Content>
  );
});

type ButtonProps = ContainerProps & {
  hover?: Pick<ContainerProps, "backgroundColor" | "backgroundOpacity">;
  onClick?: () => void;
};

export function Button(
  { hover, onClick, children, backgroundColor, backgroundOpacity, ...props }: ButtonProps,
) {
  const [hovered, setHovered] = useState(false);
  const activeBackgroundColor = hovered
    ? hover?.backgroundColor ?? backgroundColor
    : backgroundColor;
  const activeBackgroundOpacity = hovered
    ? hover?.backgroundOpacity ?? backgroundOpacity
    : backgroundOpacity;

  return (
    <Container
      {...props}
      backgroundColor={activeBackgroundColor}
      backgroundOpacity={activeBackgroundOpacity}
      onPointerOver={() => setHovered(true)}
      onPointerOut={() => setHovered(false)}
      onClick={onClick}
    >
      {children}
    </Container>
  );
}
