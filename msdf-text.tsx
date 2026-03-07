import React, { useEffect, useMemo, useState } from "react";
import { Buffer } from "node:buffer";
import * as THREE from "three/webgpu";
import { PNG } from "npm:pngjs";
import MSDFTextGeometry from "./submodules/three-msdf-text-utils/src/MSDFTextGeometry/index.js";
import MSDFTextNodeMaterial from "./submodules/three-msdf-text-utils/src/MSDFTextNodeMaterial/index.js";

type MsdfFontAssets = {
  atlas: THREE.Texture;
  font: Record<string, unknown>;
};

let fontAssetsPromise: Promise<MsdfFontAssets> | undefined;

async function loadMsdfFontAssets(): Promise<MsdfFontAssets> {
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
  atlas.needsUpdate = true;
  atlas.generateMipmaps = false;
  atlas.minFilter = THREE.LinearFilter;
  atlas.magFilter = THREE.LinearFilter;

  return { atlas, font };
}

export function getMsdfFontAssets(): Promise<MsdfFontAssets> {
  fontAssetsPromise ??= loadMsdfFontAssets();
  return fontAssetsPromise;
}

export type MsdfTextMetrics = {
  bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  };
  lineHeight: number;
  scale: number;
  width: number;
  height: number;
};

export async function measureMsdfText(
  text: string,
  fontSize: number,
  width?: number,
  align: "left" | "center" | "right" = "left",
): Promise<MsdfTextMetrics> {
  const assets = await getMsdfFontAssets();
  const geometry = new MSDFTextGeometry({
    text,
    font: assets.font,
    width,
    align,
  });
  const position = geometry.getAttribute("position");
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  if (position != null && position.count > 0) {
    minX = maxX = position.getX(0);
    minY = maxY = position.getY(0);
    for (let i = 1; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  const lineHeight = Number((assets.font as { common?: { lineHeight?: number } }).common?.lineHeight ?? 84);
  const scale = fontSize / lineHeight;
  geometry.dispose();
  return {
    bounds: { minX, maxX, minY, maxY },
    lineHeight,
    scale,
    width: (maxX - minX) * scale,
    height: (maxY - minY) * scale,
  };
}

function adaptMaterialForUIKit(
  material: InstanceType<typeof MSDFTextNodeMaterial>,
  color: string | number | THREE.Color,
) {
  const colorUniform = (material as { color: { value: THREE.Color } }).color;
  const opacityUniform = (material as { opacity: { value: number } }).opacity;
  const compatColor = new THREE.Color(color);
  colorUniform.value.copy(compatColor);

  Object.defineProperty(material, "color", {
    configurable: true,
    enumerable: true,
    get: () => compatColor,
    set: (value: string | number | THREE.Color) => {
      compatColor.set(value);
      colorUniform.value.copy(compatColor);
    },
  });

  Object.defineProperty(material, "opacity", {
    configurable: true,
    enumerable: true,
    get: () => opacityUniform.value,
    set: (value: number) => {
      opacityUniform.value = value;
    },
  });
}

export type MsdfTextProps = {
  text: string;
  color?: string | number | THREE.Color;
  opacity?: number;
  fontSize?: number;
  width?: number;
  align?: "left" | "center" | "right";
  anchorX?: "left" | "center" | "right";
  position?: [number, number, number];
};

export function MsdfText({
  text,
  color = 0xffffff,
  opacity = 1,
  fontSize = 0.00035,
  width,
  align = "left",
  anchorX = "left",
  position = [0, 0, 0],
}: MsdfTextProps) {
  const [assets, setAssets] = useState<MsdfFontAssets | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMsdfFontAssets().then((nextAssets) => {
      if (!cancelled) {
        setAssets(nextAssets);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const geometry = useMemo(() => {
    if (assets == null) {
      return null;
    }
    return new MSDFTextGeometry({
      text,
      font: assets.font,
      width,
      align,
    });
  }, [align, assets, text, width]);

  const material = useMemo(() => {
    if (assets == null) {
      return null;
    }
    const nextMaterial = new MSDFTextNodeMaterial({
      map: assets.atlas,
      color,
      opacity,
    });
    adaptMaterialForUIKit(nextMaterial, color);
    nextMaterial.side = THREE.DoubleSide;
    nextMaterial.transparent = true;
    nextMaterial.alphaTest = 0.01;
    nextMaterial.depthWrite = false;
    nextMaterial.depthTest = false;
    return nextMaterial;
  }, [assets, color, opacity]);

  useEffect(() => {
    return () => {
      geometry?.dispose();
    };
  }, [geometry]);

  if (geometry == null || material == null) {
    return null;
  }

  const layoutWidth = (geometry.layout?.width ?? 0) * fontSize;
  const xOffset = anchorX === "center" ? -layoutWidth * 0.5 : anchorX === "right" ? -layoutWidth : 0;

  return React.createElement("mesh", {
    geometry,
    material,
    rotation: [Math.PI, 0, 0],
    position: [position[0] + xOffset, position[1], position[2]],
    scale: [fontSize, fontSize, fontSize],
  });
}
