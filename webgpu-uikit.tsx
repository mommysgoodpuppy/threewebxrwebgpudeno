import React, { forwardRef, useEffect, useState } from "react";
import * as THREE from "three/webgpu";
import { Container as UIKitContainer, Content, type ContainerProperties as UIKitContainerProperties } from "./uikit-r3f.tsx";
import { measureMsdfText, MsdfText } from "./msdf-text.tsx";

type ColorValue = string | number;

export type ContainerProps = UIKitContainerProperties & {
  children?: React.ReactNode;
  backgroundOpacity?: number;
};

export const Container = forwardRef<any, ContainerProps>(({ backgroundOpacity, opacity, ...props }, forwardedRef) => {
  return <UIKitContainer ref={forwardedRef} opacity={backgroundOpacity ?? opacity} {...props} />;
});

type TextProps = Omit<UIKitContainerProperties, "children" | "width" | "height" | "color"> & {
  children: React.ReactNode;
  color?: ColorValue;
  fontSize?: number;
  fontWeight?: string | number;
  pixelSize?: number;
  textAlign?: "left" | "center" | "right";
};

export function Text({
  children,
  color = "#ffffff",
  fontSize = 16,
  fontWeight: _fontWeight,
  pixelSize = 0.001,
  textAlign = "left",
  ...props
}: TextProps) {
  const text = String(children ?? "");
  const [metrics, setMetrics] = useState<{
    width: number;
    height: number;
    bounds: { minX: number; maxX: number; minY: number; maxY: number };
    scale: number;
  }>({
    width: Math.max(1, text.length * fontSize * 0.6),
    height: fontSize,
    bounds: { minX: 0, maxX: fontSize, minY: -fontSize, maxY: 0 },
    scale: fontSize / 84,
  });

  useEffect(() => {
    let cancelled = false;
    measureMsdfText(text, fontSize, undefined, textAlign).then((nextMetrics) => {
      if (!cancelled) {
        setMetrics(nextMetrics);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fontSize, text, textAlign]);

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
      <MsdfText text={text} color={color} fontSize={worldScale} align={textAlign} position={textPosition} />
    </Content>
  );
}

type ButtonProps = ContainerProps & {
  hover?: Pick<ContainerProps, "backgroundColor" | "backgroundOpacity">;
  onClick?: () => void;
};

export function Button({ hover, onClick, children, backgroundColor, backgroundOpacity, ...props }: ButtonProps) {
  const [hovered, setHovered] = useState(false);
  const activeBackgroundColor = hovered ? hover?.backgroundColor ?? backgroundColor : backgroundColor;
  const activeBackgroundOpacity = hovered ? hover?.backgroundOpacity ?? backgroundOpacity : backgroundOpacity;

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
