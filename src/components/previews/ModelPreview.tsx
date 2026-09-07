import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { ColladaLoader } from "three/examples/jsm/loaders/ColladaLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { TDSLoader } from "three/examples/jsm/loaders/TDSLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { indexedAssetStreamUrl } from "../../lib/desktopAssets";
import { readRangedFile } from "../../lib/rangedFile";
import type { Asset } from "../../types";

async function loadModel(asset: Asset, signal: AbortSignal): Promise<THREE.Object3D> {
  const url = indexedAssetStreamUrl(asset);
  const buffer = await readRangedFile(url, signal);
  signal.throwIfAborted();
  const base = new URL(".", url).href;
  switch (asset.format.toUpperCase()) {
    case "GLB":
    case "GLTF": return (await new GLTFLoader().parseAsync(buffer, base)).scene;
    case "OBJ": return new OBJLoader().parse(new TextDecoder().decode(buffer));
    case "FBX": return new FBXLoader().parse(buffer, base);
    case "DAE": {
      const collada = new ColladaLoader().parse(new TextDecoder().decode(buffer), base);
      if (!collada?.scene) throw new Error("DAE 文件没有可显示的场景");
      return collada.scene;
    }
    case "3DS": return new TDSLoader().parse(buffer, base);
    case "STL": {
      const geometry = new STLLoader().parse(buffer);
      geometry.computeVertexNormals();
      return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x8aa4d6, roughness: 0.58, metalness: 0.12 }));
    }
    default: throw new Error(`暂不支持 ${asset.format} 的内嵌预览，请使用系统查看器打开`);
  }
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      material.dispose();
    }
  });
}

export function ModelPreview({ asset }: { asset: Asset }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    const request = new AbortController();
    let model: THREE.Object3D | undefined;
    let frame = 0;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111722);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 10000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.append(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 2.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(3, 5, 4);
    scene.add(key);
    const grid = new THREE.GridHelper(10, 10, 0x475569, 0x263244);
    scene.add(grid);

    const resize = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    const animate = () => {
      if (disposed) return;
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    animate();
    setLoading(true);
    setError("");
    void loadModel(asset, request.signal)
      .then((loaded) => {
        if (disposed) {
          disposeObject(loaded);
          return;
        }
        model = loaded;
        scene.add(loaded);
        const box = new THREE.Box3().setFromObject(loaded);
        const center = box.getCenter(new THREE.Vector3());
        const size = Math.max(box.getSize(new THREE.Vector3()).length(), 0.01);
        loaded.position.sub(center);
        camera.position.set(size * 0.8, size * 0.55, size * 0.8);
        camera.near = Math.max(size / 1000, 0.001);
        camera.far = Math.max(size * 100, 100);
        camera.updateProjectionMatrix();
        controls.target.set(0, 0, 0);
        controls.update();
      })
      .catch((reason) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : "无法加载 3D 模型");
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });

    return () => {
      disposed = true;
      request.abort();
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      if (model) disposeObject(model);
      grid.geometry.dispose();
      const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
      gridMaterials.forEach((material) => material.dispose());
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [asset]);

  return (
    <div ref={hostRef} className="model-preview">
      {loading && <span className="preview-adapter-message">正在加载 3D 模型…</span>}
      {error && <span className="preview-adapter-message">{error}</span>}
    </div>
  );
}
