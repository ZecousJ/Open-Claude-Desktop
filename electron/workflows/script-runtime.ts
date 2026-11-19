import variant from "@jitl/quickjs-singlefile-cjs-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSHandle,
} from "quickjs-emscripten-core";

const executionSliceMs = 200;
const heapLimitBytes = 16 * 1024 * 1024;
// The pinned QuickJS build reserves a 5 MiB C stack before the heap.
const wasmMemoryPages = (heapLimitBytes + 5 * 1024 * 1024) / (64 * 1024);

function unwrapVariant(imported: typeof variant | { default: typeof variant }) {
  return "default" in imported ? imported.default : imported;
}

export async function workflowRuntimeFactory() {
  // This build's QuickJS allocator cannot count aggregate allocations.
  // Fixed memory also keeps heap views valid while running pending jobs.
  const wasmMemory = new WebAssembly.Memory({
    initial: wasmMemoryPages,
    maximum: wasmMemoryPages,
  });
  const module = await newQuickJSWASMModuleFromVariant(
    newVariant(unwrapVariant(variant), { wasmMemory }),
  );
  return () => workflowRuntime(module);
}

function workflowRuntime(module: Awaited<ReturnType<typeof newQuickJSWASMModuleFromVariant>>) {
  const vm = module.newContext();
  const { runtime } = vm;
  runtime.setMemoryLimit(heapLimitBytes);
  runtime.setMaxStackSize(512 * 1024);
  let deadline = 0;
  const timedOut = () => performance.now() >= deadline;
  runtime.setInterruptHandler(timedOut);
  const check = () => {
    if (timedOut())
      throw Error("The workflow script exceeded its execution time limit.");
  };
  return {
    vm,
    begin() {
      deadline = performance.now() + executionSliceMs;
    },
    jobs() {
      while (runtime.hasPendingJob()) {
        check();
        const job = runtime.executePendingJobs(128);
        if (job.error) throw workflowError(vm, job.error);
      }
      check();
    },
    value(result: ReturnType<QuickJSContext["evalCode"]>) {
      if (result.error) {
        if (timedOut()) result.error.dispose();
        check();
        throw workflowError(vm, result.error);
      }
      return result.value;
    },
  };
}

export function workflowError(vm: QuickJSContext, handle: QuickJSHandle) {
  return handle.consume((value) => {
    if (vm.typeof(value) === "string") return Error(vm.getString(value));
    return vm
      .getProp(value, "message")
      .consume((message) =>
        Error(
          vm.typeof(message) === "string"
            ? vm.getString(message)
            : "The workflow script failed.",
        ),
      );
  });
}
