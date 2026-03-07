import { Box3, InstancedBufferAttribute, Mesh, Object3DEventMap, Sphere } from 'three'
import { createPanelGeometry } from '../../submodules/uikit/packages/uikit/src/panel/utils.ts'
import {
  instancedPanelDepthMaterial,
  instancedPanelDistanceMaterial,
} from '../../submodules/uikit/packages/uikit/src/panel/panel-material.ts'
import { RootContext } from '../context.ts'
import { computeWorldToGlobalMatrix } from '../../submodules/uikit/packages/uikit/src/utils.ts'

export class InstancedPanelMesh extends Mesh {
  public count = 0

  protected readonly isInstancedMesh = true
  public readonly instanceColor = null
  public readonly morphTexture = null
  public readonly boundingBox = new Box3()
  public readonly boundingSphere = new Sphere()

  private readonly customUpdateMatrixWorld = () => computeWorldToGlobalMatrix(this.root, this.matrixWorld)

  constructor(
    protected readonly root: Omit<RootContext, 'glyphGroupManager' | 'panelGroupManager'>,
    public readonly instanceMatrix: InstancedBufferAttribute,
    instanceData: InstancedBufferAttribute | undefined,
    instanceClipping: InstancedBufferAttribute | undefined,
    instanceDataRows: [InstancedBufferAttribute, InstancedBufferAttribute, InstancedBufferAttribute, InstancedBufferAttribute],
    instanceClippingRows: [
      InstancedBufferAttribute,
      InstancedBufferAttribute,
      InstancedBufferAttribute,
      InstancedBufferAttribute,
    ],
  ) {
    const panelGeometry = createPanelGeometry()
    super(panelGeometry)
    this.pointerEvents = 'none'
    if (instanceData != null) {
      panelGeometry.attributes.aData = instanceData
    }
    if (instanceClipping != null) {
      panelGeometry.attributes.aClipping = instanceClipping
    }
    panelGeometry.attributes.aData0 = instanceDataRows[0]
    panelGeometry.attributes.aData1 = instanceDataRows[1]
    panelGeometry.attributes.aData2 = instanceDataRows[2]
    panelGeometry.attributes.aData3 = instanceDataRows[3]
    panelGeometry.attributes.aClipping0 = instanceClippingRows[0]
    panelGeometry.attributes.aClipping1 = instanceClippingRows[1]
    panelGeometry.attributes.aClipping2 = instanceClippingRows[2]
    panelGeometry.attributes.aClipping3 = instanceClippingRows[3]
    this.customDepthMaterial = instancedPanelDepthMaterial
    this.customDistanceMaterial = instancedPanelDistanceMaterial
    this.frustumCulled = false
    root.onUpdateMatrixWorldSet.add(this.customUpdateMatrixWorld)
  }

  dispose() {
    this.root.onUpdateMatrixWorldSet.delete(this.customUpdateMatrixWorld)
    this.dispatchEvent({ type: 'dispose' as keyof Object3DEventMap })
    this.geometry.dispose()
  }

  clone(): this {
    const cloned = new InstancedPanelMesh(
      this.root,
      this.instanceMatrix,
      this.geometry.attributes.aData as InstancedBufferAttribute | undefined,
      this.geometry.attributes.aClipping as InstancedBufferAttribute | undefined,
      [
        this.geometry.attributes.aData0 as InstancedBufferAttribute,
        this.geometry.attributes.aData1 as InstancedBufferAttribute,
        this.geometry.attributes.aData2 as InstancedBufferAttribute,
        this.geometry.attributes.aData3 as InstancedBufferAttribute,
      ],
      [
        this.geometry.attributes.aClipping0 as InstancedBufferAttribute,
        this.geometry.attributes.aClipping1 as InstancedBufferAttribute,
        this.geometry.attributes.aClipping2 as InstancedBufferAttribute,
        this.geometry.attributes.aClipping3 as InstancedBufferAttribute,
      ],
    ) as this
    cloned.count = this.count
    cloned.material = this.material
    return cloned
  }

  copy(): this {
    throw new Error('InstancedPanelMesh.copy() is not supported. Use clone() instead.')
  }

  //functions not needed because intersection (and morphing) is intenionally disabled
  computeBoundingBox(): void {}
  computeBoundingSphere(): void {}
  updateMorphTargets(): void {}
  raycast(): void {}
  spherecast(): void {}
}
