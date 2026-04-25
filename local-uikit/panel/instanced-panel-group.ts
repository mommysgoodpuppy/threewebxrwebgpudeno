import {
  InstancedBufferAttribute,
  Material,
  DynamicDrawUsage,
  Object3D,
  MeshPhongMaterial,
  MeshPhysicalMaterial,
  MeshBasicNodeMaterial,
} from 'three'
import {
  Bucket,
  addToSortedBuckets,
  removeFromSortedBuckets,
  updateSortedBucketsAllocation,
  resizeSortedBucketsSpace,
} from '../../submodules/uikit/packages/uikit/src/allocation/sorted-buckets.ts'
import { MaterialClass, createPanelMaterial } from '../../submodules/uikit/packages/uikit/src/panel/panel-material.ts'
import { canUseWebgpuPanelMaterial, createWebgpuPanelMaterial } from './panel-material-webgpu.ts'
import { InstancedPanel } from './instanced-panel.ts'
import { InstancedPanelMesh } from './instanced-panel-mesh.ts'
import { ElementType, OrderInfo, setupRenderOrder } from '../../submodules/uikit/packages/uikit/src/order.ts'
import { computed } from '@preact/signals-core'
import { Properties } from '../../submodules/uikit/packages/uikit/src/properties/index.ts'
import { RootContext } from '../context.ts'
import type { Component } from '../components/component.ts'
import {
  registerInstancedPanelMeshForRaythreeMeshLowerer,
  unregisterInstancedPanelMeshForRaythreeMeshLowerer,
} from '../raylibUikitMeshLowererRegistry.ts'

export type ShadowProperties = {
  receiveShadow?: boolean
  castShadow?: boolean
}

export type RenderProperties = {
  depthWrite?: boolean
  depthTest?: boolean
  renderOrder?: number
}

export class PlasticMaterial extends MeshPhongMaterial {
  constructor() {
    super({
      specular: '#111',
      shininess: 100,
    })
  }
}

export class GlassMaterial extends MeshPhysicalMaterial {
  constructor() {
    super({
      roughness: 0.1,
      reflectivity: 0.5,
      iridescence: 0.001,
      thickness: 0.05,
      metalness: 0.3,
      ior: 2,
    })
  }
}

export class MetalMaterial extends MeshPhysicalMaterial {
  constructor() {
    super({
      iridescence: 0.001,
      metalness: 0.8,
      roughness: 0.1,
    })
  }
}
const materialClasses = {
  glass: GlassMaterial,
  metal: MetalMaterial,
  plastic: PlasticMaterial,
}

export function resolvePanelMaterialClassProperty(input: NonNullable<PanelGroupProperties['panelMaterialClass']>) {
  if (typeof input != 'string') {
    return input
  }
  return materialClasses[input]
}

export type PanelGroupProperties = {
  panelMaterialClass?: MaterialClass | keyof typeof materialClasses
} & ShadowProperties &
  RenderProperties

export function computedPanelGroupDependencies(properties: Properties) {
  return computed<Required<PanelGroupProperties>>(() => {
    return {
      panelMaterialClass: resolvePanelMaterialClassProperty(properties.value.panelMaterialClass),
      castShadow: properties.value.castShadow,
      receiveShadow: properties.value.receiveShadow,
      depthWrite: properties.value.depthWrite ?? false,
      depthTest: properties.value.depthTest,
      renderOrder: properties.value.renderOrder,
    }
  })
}

export class PanelGroupManager {
  private map = new Map<MaterialClass, Map<string, InstancedPanelGroup>>()

  constructor(
    private readonly root: Omit<RootContext, 'glyphGroupManager' | 'panelGroupManager'>,
    private readonly object: Component,
  ) {}

  init(abortSignal: AbortSignal) {
    const onFrame = () => this.traverse((group) => group.onFrame())
    this.root.onFrameSet.add(onFrame)
    abortSignal.addEventListener('abort', () => {
      this.root.onFrameSet.delete(onFrame)
      this.traverse((group) => group.destroy())
    })
  }

  private traverse(fn: (group: InstancedPanelGroup) => void) {
    for (const groups of this.map.values()) {
      for (const group of groups.values()) {
        fn(group)
      }
    }
  }

  /**
   * All instanced uikit groups (same objects WebGPU draws one material per).
   * Raylib UI replication should read panel instances from these groups, not by scene heuristics.
   */
  forEachGroup(fn: (group: InstancedPanelGroup) => void) {
    this.traverse(fn)
  }

  getGroup({ majorIndex, minorIndex }: OrderInfo, properties: Required<PanelGroupProperties>) {
    const materialClass = resolvePanelMaterialClassProperty(properties.panelMaterialClass)
    let groups = this.map.get(materialClass)
    if (groups == null) {
      this.map.set(materialClass, (groups = new Map()))
    }
    const key = [
      majorIndex,
      minorIndex,
      properties.renderOrder,
      properties.depthTest,
      properties.depthWrite,
      properties.receiveShadow,
      properties.castShadow,
    ].join(',')
    let panelGroup = groups.get(key)
    if (panelGroup == null) {
      groups.set(
        key,
        (panelGroup = new InstancedPanelGroup(
          this.object,
          this.root,
          {
            elementType: ElementType.Panel,
            minorIndex,
            majorIndex,
            patchIndex: 0,
          },
          properties,
        )),
      )
    }
    return panelGroup
  }
}

const nextFrame = Symbol('nextFrame')

export class InstancedPanelGroup {
  private mesh?: InstancedPanelMesh
  public instanceMatrix!: InstancedBufferAttribute
  public instanceData!: InstancedBufferAttribute
  public instanceClipping!: InstancedBufferAttribute
  public instanceDataRows!: [InstancedBufferAttribute, InstancedBufferAttribute, InstancedBufferAttribute, InstancedBufferAttribute]
  public instanceClippingRows!: [
    InstancedBufferAttribute,
    InstancedBufferAttribute,
    InstancedBufferAttribute,
    InstancedBufferAttribute,
  ]
  private instanceMaterial?: Material

  private buckets: Array<Bucket<InstancedPanel>> = []
  private elementCount: number = 0
  private bufferElementSize: number = 0

  public instanceDataOnUpdate!: InstancedBufferAttribute['addUpdateRange']

  private nextUpdateTime: typeof nextFrame | number | undefined
  private nextUpdateTimeoutRef: NodeJS.Timeout | undefined

  private activateElement = (element: InstancedPanel, bucket: Bucket<InstancedPanel>, indexInBucket: number) => {
    const index = bucket.offset + indexInBucket
    this.instanceData.set(element.materialConfig.defaultData, 16 * index)
    this.instanceData.addUpdateRange(16 * index, 16)
    this.instanceData.needsUpdate = true
    this.syncRows(this.instanceData, this.instanceDataRows, 16 * index, 16)
    element.activate(bucket, indexInBucket)
  }

  private setElementIndex = (element: InstancedPanel, index: number) => {
    element.setIndexInBucket(index)
  }

  private bufferCopyWithin = (targetIndex: number, startIndex: number, endIndex: number) => {
    copyWithinAttribute(this.instanceMatrix, targetIndex, startIndex, endIndex)
    copyWithinAttribute(this.instanceData, targetIndex, startIndex, endIndex)
    copyWithinAttribute(this.instanceClipping, targetIndex, startIndex, endIndex)
    this.syncRows(this.instanceData, this.instanceDataRows, targetIndex * 16, (endIndex - startIndex) * 16)
    this.syncRows(this.instanceClipping, this.instanceClippingRows, targetIndex * 16, (endIndex - startIndex) * 16)
  }

  private clearBufferAt = (index: number) => {
    //hiding the element by writing a 0 matrix (0 scale ...)
    const bufferOffset = index * 16
    this.instanceMatrix.array.fill(0, bufferOffset, bufferOffset + 16)
    this.instanceMatrix.addUpdateRange(bufferOffset, 16)
    this.instanceMatrix.needsUpdate = true
  }

  constructor(
    private readonly object: Component,
    public readonly root: Omit<RootContext, 'glyphGroupManager' | 'panelGroupManager'>,
    private readonly orderInfo: OrderInfo,
    private readonly panelGroupProperties: Required<PanelGroupProperties>,
  ) {
  }

  private updateCount(): void {
    const lastBucket = this.buckets[this.buckets.length - 1]!
    const count = lastBucket.offset + lastBucket.elements.length
    if (this.mesh == null) {
      return
    }
    this.mesh.count = count
    this.mesh.visible = count > 0
    this.root.requestRender?.()
  }

  private requestUpdate(time: number): void {
    if (this.nextUpdateTime == nextFrame) {
      return
    }

    const forTime = performance.now() + time

    if (this.nextUpdateTime != null && this.nextUpdateTime < forTime) {
      return
    }
    this.nextUpdateTime = forTime
    clearTimeout(this.nextUpdateTimeoutRef)
    this.nextUpdateTimeoutRef = setTimeout(this.requestUpdateNextFrame.bind(this), time)
  }

  private requestUpdateNextFrame() {
    this.nextUpdateTime = nextFrame
    clearTimeout(this.nextUpdateTimeoutRef)
    this.nextUpdateTimeoutRef = undefined
    this.root.requestFrame?.()
  }

  insert(bucketIndex: number, panel: InstancedPanel): void {
    this.elementCount += 1
    if (!addToSortedBuckets(this.buckets, bucketIndex, panel, this.activateElement)) {
      this.updateCount()
      return
    }
    this.requestUpdateNextFrame()
  }

  delete(bucketIndex: number, elementIndex: number | undefined, panel: InstancedPanel): void {
    this.elementCount -= 1
    if (
      !removeFromSortedBuckets(
        this.buckets,
        bucketIndex,
        panel,
        elementIndex,
        this.activateElement,
        this.clearBufferAt,
        this.setElementIndex,
        this.bufferCopyWithin,
      )
    ) {
      //update count already requests a render
      this.updateCount()
      return
    }
    this.root.requestRender?.()
    this.requestUpdate(1000) //request update in 1 second
  }

  onFrame(): void {
    if (this.nextUpdateTime != nextFrame) {
      return
    }
    this.nextUpdateTime = undefined
    this.update()
  }

  private update(): void {
    if (this.elementCount === 0) {
      if (this.mesh != null) {
        this.mesh.visible = false
      }
      return
    }
    //buffer is resized to have space for 150% of the actually needed elements
    if (this.elementCount > this.bufferElementSize) {
      //buffer is to small to host the current elements
      this.resize()
      //we need to execute updateSortedBucketsAllocation after resize so that updateSortedBucketsAllocation has enough space to arrange all the elements
      updateSortedBucketsAllocation(this.buckets, this.activateElement, this.bufferCopyWithin)
    } else if (this.elementCount <= this.bufferElementSize / 3) {
      //we need to execute updateSortedBucketsAllocation first, so we still have access to the elements in the space that will be removed by the resize
      //TODO: this could be improved since now we are re-arraging in place and then copying. we could rearrange while copying. Not sure if faster though?
      updateSortedBucketsAllocation(this.buckets, this.activateElement, this.bufferCopyWithin)
      //buffer is at least 300% bigger than the needed space
      this.resize()
    } else {
      updateSortedBucketsAllocation(this.buckets, this.activateElement, this.bufferCopyWithin)
    }
    this.mesh!.count = this.elementCount
    this.mesh!.visible = true
  }

  private resize(): void {
    const oldBufferSize = this.bufferElementSize
    this.bufferElementSize = Math.ceil(this.elementCount * 1.5)
    if (this.mesh != null) {
      unregisterInstancedPanelMeshForRaythreeMeshLowerer(this.mesh)
      this.mesh.dispose()
      this.object.remove(this.mesh)
    }
    resizeSortedBucketsSpace(this.buckets, oldBufferSize, this.bufferElementSize)
    const matrixArray = new Float32Array(this.bufferElementSize * 16)
    if (this.instanceMatrix != null) {
      matrixArray.set(this.instanceMatrix.array.subarray(0, matrixArray.length))
    }
    this.instanceMatrix = new InstancedBufferAttribute(matrixArray, 16, false)
    this.instanceMatrix.setUsage(DynamicDrawUsage)
    const dataArray = new Float32Array(this.bufferElementSize * 16)
    if (this.instanceData != null) {
      dataArray.set(this.instanceData.array.subarray(0, dataArray.length))
    }
    this.instanceData = new InstancedBufferAttribute(dataArray, 16, false)
    this.instanceDataOnUpdate = (start, count) => {
      this.instanceData.addUpdateRange(start, count)
      this.instanceData.needsUpdate = true
      this.syncRows(this.instanceData, this.instanceDataRows, start, count)
    }
    this.instanceData.setUsage(DynamicDrawUsage)
    this.instanceDataRows = createSplitInstanceRows(this.bufferElementSize)
    const clippingArray = new Float32Array(this.bufferElementSize * 16)
    if (this.instanceClipping != null) {
      clippingArray.set(this.instanceClipping.array.subarray(0, clippingArray.length))
    }
    this.instanceClipping = new InstancedBufferAttribute(clippingArray, 16, false)
    this.instanceClipping.setUsage(DynamicDrawUsage)
    this.instanceClippingRows = createSplitInstanceRows(this.bufferElementSize)
    this.syncRows(this.instanceData, this.instanceDataRows, 0, this.bufferElementSize * 16)
    this.syncRows(this.instanceClipping, this.instanceClippingRows, 0, this.bufferElementSize * 16)
    this.instanceMaterial?.dispose()
    const materialClass = resolvePanelMaterialClassProperty(this.panelGroupProperties.panelMaterialClass)
    this.instanceMaterial = canUseWebgpuPanelMaterial(materialClass)
      ? createWebgpuPanelMaterial(materialClass)
      : createPanelMaterial(materialClass, { type: 'instanced' })
    this.instanceMaterial.depthTest = this.panelGroupProperties.depthTest
    this.instanceMaterial.depthWrite = this.panelGroupProperties.depthWrite
    this.mesh = new InstancedPanelMesh(
      this.root,
      this.instanceMatrix,
      this.instanceData,
      this.instanceClipping,
      this.instanceDataRows,
      this.instanceClippingRows,
    )
    this.mesh.renderOrder = this.panelGroupProperties.renderOrder
    setupRenderOrder(this.mesh, { peek: () => this.root }, { value: this.orderInfo })
    this.mesh.material = this.instanceMaterial
    this.mesh.receiveShadow = this.panelGroupProperties.receiveShadow
    this.mesh.castShadow = this.panelGroupProperties.castShadow
    this.object.addUnsafe(this.mesh)
    registerInstancedPanelMeshForRaythreeMeshLowerer(this.mesh)
  }

  /** The instanced draw mesh; same as the WebGPU path, `undefined` before first layout/resize. */
  getInstancedPanelMesh(): InstancedPanelMesh | undefined {
    return this.mesh
  }

  destroy() {
    clearTimeout(this.nextUpdateTimeoutRef)
    if (this.mesh == null) {
      if (!(this.instanceMaterial instanceof MeshBasicNodeMaterial)) {
        this.instanceMaterial?.dispose()
      }
      return
    }
    unregisterInstancedPanelMeshForRaythreeMeshLowerer(this.mesh)
    this.object.remove(this.mesh)
    this.mesh?.dispose()
    if (!(this.instanceMaterial instanceof MeshBasicNodeMaterial)) {
      this.instanceMaterial?.dispose()
    }
  }

  public syncInstanceData(start: number, count: number) {
    this.syncRows(this.instanceData, this.instanceDataRows, start, count)
  }

  public syncInstanceClipping(start: number, count: number) {
    this.syncRows(this.instanceClipping, this.instanceClippingRows, start, count)
  }

  private syncRows(
    source: InstancedBufferAttribute,
    rows:
      | [InstancedBufferAttribute, InstancedBufferAttribute, InstancedBufferAttribute, InstancedBufferAttribute]
      | undefined,
    start: number,
    count: number,
  ) {
    if (rows == null || count <= 0) {
      return
    }
    const firstInstance = Math.max(0, Math.floor(start / 16))
    const endInstance = Math.min(this.bufferElementSize, Math.ceil((start + count) / 16))
    for (let instanceIndex = firstInstance; instanceIndex < endInstance; instanceIndex++) {
      const sourceOffset = instanceIndex * 16
      const targetOffset = instanceIndex * 4
      rows[0].array.set(source.array.subarray(sourceOffset, sourceOffset + 4), targetOffset)
      rows[1].array.set(source.array.subarray(sourceOffset + 4, sourceOffset + 8), targetOffset)
      rows[2].array.set(source.array.subarray(sourceOffset + 8, sourceOffset + 12), targetOffset)
      rows[3].array.set(source.array.subarray(sourceOffset + 12, sourceOffset + 16), targetOffset)
    }
    const updateStart = firstInstance * 4
    const updateCount = Math.max(0, (endInstance - firstInstance) * 4)
    for (const row of rows) {
      row.addUpdateRange(updateStart, updateCount)
      row.needsUpdate = true
    }
  }
}

function copyWithinAttribute(
  attribute: InstancedBufferAttribute,
  targetIndex: number,
  startIndex: number,
  endIndex: number,
) {
  const itemSize = attribute.itemSize
  const start = startIndex * itemSize
  const end = endIndex * itemSize
  const target = targetIndex * itemSize
  attribute.array.copyWithin(target, start, end)
  const count = end - start
  attribute.addUpdateRange(start, count)
  attribute.addUpdateRange(target, count)
  attribute.needsUpdate = true
}

function createSplitInstanceRows(bufferElementSize: number) {
  const rows = [
    new InstancedBufferAttribute(new Float32Array(bufferElementSize * 4), 4, false),
    new InstancedBufferAttribute(new Float32Array(bufferElementSize * 4), 4, false),
    new InstancedBufferAttribute(new Float32Array(bufferElementSize * 4), 4, false),
    new InstancedBufferAttribute(new Float32Array(bufferElementSize * 4), 4, false),
  ] as [InstancedBufferAttribute, InstancedBufferAttribute, InstancedBufferAttribute, InstancedBufferAttribute]
  for (const row of rows) {
    row.setUsage(DynamicDrawUsage)
  }
  return rows
}
