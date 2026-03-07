import React, { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";

type RoundedPanelProps = {
  width: number;
  height: number;
  radius?: number;
  borderWidth?: number;
  backgroundColor: string | number | THREE.Color;
  borderColor?: string | number | THREE.Color;
  opacity?: number;
  position?: [number, number, number];
  quaternion?: [number, number, number, number];
  matrix?: number[];
  matrixAutoUpdate?: boolean;
};

function createRoundedRectMaterial({
  width,
  height,
  radius = 0.02,
  borderWidth = 0,
  backgroundColor,
  borderColor = backgroundColor,
  opacity = 1,
}: Omit<RoundedPanelProps, "position" | "quaternion" | "matrix" | "matrixAutoUpdate">) {
  const safeRadius = Math.min(radius, width * 0.5, height * 0.5);
  const safeBorderWidth = Math.max(0, Math.min(borderWidth, safeRadius, width * 0.5, height * 0.5));

  const uv = TSL.uv().sub(TSL.vec2(0.5)).mul(TSL.vec2(width, height));
  const halfSize = TSL.vec2(width * 0.5, height * 0.5);
  const outerCorner = halfSize.sub(TSL.float(safeRadius));
  const outerQ = uv.abs().sub(outerCorner);
  const outerSdf = outerQ.max(TSL.vec2(0, 0)).length()
    .add(outerQ.x.max(outerQ.y).min(0.0))
    .sub(safeRadius)
    .toVar("outerSdf");
  const outerAa = TSL.fwidth(outerSdf).max(0.0005);
  const outerAlpha = TSL.smoothstep(outerAa.negate(), outerAa, outerSdf).oneMinus().toVar("outerAlpha");

  let fillMask = TSL.float(1);
  if (safeBorderWidth > 0) {
    const innerHalfSize = halfSize.sub(TSL.vec2(safeBorderWidth, safeBorderWidth));
    const innerRadius = Math.max(0, safeRadius - safeBorderWidth);
    const innerCorner = innerHalfSize.sub(TSL.float(innerRadius));
    const innerQ = uv.abs().sub(innerCorner);
    const innerSdf = innerQ.max(TSL.vec2(0, 0)).length()
      .add(innerQ.x.max(innerQ.y).min(0.0))
      .sub(innerRadius)
      .toVar("innerSdf");
    const innerAa = TSL.fwidth(innerSdf).max(0.0005);
    fillMask = TSL.smoothstep(innerAa.negate(), innerAa, innerSdf).oneMinus().toVar("fillMask");
  }

  const panelColor = TSL.mix(TSL.color(borderColor), TSL.color(backgroundColor), fillMask);

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    toneMapped: false,
  });

  material.colorNode = TSL.vec4(panelColor, outerAlpha.mul(opacity));
  material.alphaToCoverage = true;
  material.alphaTest = 0.001;

  return material;
}

export function RoundedPanel(props: RoundedPanelProps) {
  const geometry = useMemo(() => new THREE.PlaneGeometry(props.width, props.height), [props.height, props.width]);
  const material = useMemo(
    () => createRoundedRectMaterial(props),
    [
      props.backgroundColor,
      props.borderColor,
      props.borderWidth,
      props.height,
      props.opacity,
      props.radius,
      props.width,
    ],
  );

  useEffect(() => {
    return () => {
      geometry.dispose();
    };
  }, [geometry, material]);

  return React.createElement("mesh", {
    geometry,
    material,
    position: props.position ?? [0, 0, 0],
    quaternion: props.quaternion,
    matrix: props.matrix,
    matrixAutoUpdate: props.matrixAutoUpdate,
  });
}
