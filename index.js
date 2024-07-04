"use strict";
async function main() {
    const adapter = await navigator.gpu?.requestAdapter();
    const device = await adapter?.requestDevice({
        requiredFeatures: ["indirect-first-instance"]
    });
    if (!device) {
        throw new Error("Browser does not support WebGPU");
    }
    const canvas = document.querySelector("canvas");
    if (!canvas) {
        throw new Error("Unable to find canvas");
    }
    const context = canvas.getContext("webgpu");
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format });
    const shaderModule = device.createShaderModule({
        label: "Main shader",
        code: `
struct VertexInput {
  @builtin(instance_index) instance : u32,

  @location(0) position: vec2<f32>,
};

struct VertexOutput {
  @builtin(position) clip_position: vec4<f32>,
  @location(0) color: vec3<f32>,
};

@group(0) @binding(0) var<uniform> offset: vec4<f32>;
@group(0) @binding(1) var color_texture: texture_2d<f32>;
@group(0) @binding(2) var color_sampler: sampler; 

@vertex
fn vs_main(model: VertexInput) -> VertexOutput {
  var out: VertexOutput;

  out.color = vec3<f32>(1, 0, 0);
  out.clip_position = vec4<f32>(model.position, 0, 1) + vec4<f32>(offset[model.instance], 0, 0, 0);

  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  return textureSample(color_texture, color_sampler, vec2<f32>(1., 1.));
  // return vec4<f32>(in.color, 1.0);
}`
    });
    const pipeline = device.createRenderPipeline({
        label: "Main render pipeline",
        layout: 'auto',
        vertex: {
            module: shaderModule,
            entryPoint: "vs_main",
            buffers: [
                {
                    arrayStride: 2 * 4,
                    attributes: [
                        {
                            shaderLocation: 0,
                            offset: 0,
                            format: "float32x2"
                        }
                    ]
                }
            ]
        },
        fragment: {
            module: shaderModule,
            entryPoint: "fs_main",
            targets: [{ format }]
        }
    });
    const passDesc = {
        label: 'Main renderPass',
        colorAttachments: [
            {
                view: null,
                clearValue: [0, 0, 1, 1],
                loadOp: 'clear',
                storeOp: 'store',
            },
        ],
    };
    const vertexBufferCPU = new Float32Array([0, .5, -.5, -.5, .5, -.5]);
    const vertexBuffer = device.createBuffer({
        label: "Main vertex buffer",
        size: vertexBufferCPU.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    device.queue.writeBuffer(vertexBuffer, 0, vertexBufferCPU);
    const uniformBufferCPU = new Float32Array([.25, .5, 0, 0,]);
    const uniformBuffer = device.createBuffer({
        label: "Main uniform buffer",
        size: uniformBufferCPU.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    device.queue.writeBuffer(uniformBuffer, 0, uniformBufferCPU);
    const texture = device.createTexture({
        label: "texture",
        format: "rgba8unorm",
        size: {
            width: 4096,
            height: 4096,
        },
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING
    });
    const sampler = device.createSampler();
    const bindGroup = device.createBindGroup({
        label: "Main bind group",
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: uniformBuffer
                }
            },
            {
                binding: 1,
                resource: texture.createView(),
            },
            {
                binding: 2,
                resource: sampler
            }
        ]
    });
    const white = new Uint8Array(4096 * 4096 * 4);
    for (let i = 0; i < white.length; i++) {
        white[i] = 255;
    }
    const gray = new Uint8Array(4096 * 4096 * 4);
    for (let i = 0; i < gray.length; i++) {
        gray[i] = 122;
    }
    const allTextureData = [white, gray];
    let nextTextureData = white;
    let j = 0;
    setInterval(() => {
        nextTextureData = allTextureData[++j % allTextureData.length];
    }, 6);
    let stagingBuffers = [];
    function getOrCreateStagingBuffer() {
        if (stagingBuffers.length) {
            return stagingBuffers.pop();
        }
        return device.createBuffer({
            label: "texture staging buffer",
            size: 4096 * 4096 * 4,
            usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
            mappedAtCreation: true
        });
    }
    function renderWithWriteTexture() {
        passDesc.colorAttachments[0].view = context.getCurrentTexture().createView();
        const encoder = device.createCommandEncoder({ label: "Render pass encoder" });
        device.queue.writeTexture({ texture }, nextTextureData, { bytesPerRow: 4096 * 4 }, { width: 4096, height: 4096 });
        const pass = encoder.beginRenderPass(passDesc);
        pass.setVertexBuffer(0, vertexBuffer);
        pass.setBindGroup(0, bindGroup);
        pass.setPipeline(pipeline);
        pass.draw(3, 1, 0, 0);
        pass.end();
        const commands = encoder.finish();
        device.queue.submit([commands]);
        window.requestAnimationFrame(renderWithWriteTexture);
    }
    function renderWithMappedBufferToTexture() {
        passDesc.colorAttachments[0].view = context.getCurrentTexture().createView();
        const encoder = device.createCommandEncoder({ label: "Render pass encoder" });
        const staging = getOrCreateStagingBuffer();
        const bytes = new Uint8Array(staging.getMappedRange());
        bytes.set(nextTextureData);
        staging.unmap();
        encoder.copyBufferToTexture({ buffer: staging, bytesPerRow: 4096 * 4 }, { texture }, {
            width: 4096,
            height: 4096,
        });
        const pass = encoder.beginRenderPass(passDesc);
        pass.setVertexBuffer(0, vertexBuffer);
        pass.setBindGroup(0, bindGroup);
        pass.setPipeline(pipeline);
        pass.draw(3, 1, 0, 0);
        pass.end();
        const commands = encoder.finish();
        device.queue.submit([commands]);
        staging.mapAsync(GPUMapMode.WRITE)
            .then(() => {
            stagingBuffers.push(staging);
        });
        window.requestAnimationFrame(renderWithMappedBufferToTexture);
    }
    // window.requestAnimationFrame(renderWithWriteTexture)
    window.requestAnimationFrame(renderWithMappedBufferToTexture);
}
main();
