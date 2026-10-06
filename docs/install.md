# Installation

Install four things in this order: Python, a GPU build of PyTorch, the HydroForge
framework and the CaMa-Flood-GPU package (`cmfgpu`).

## Requirements

- Python 3.11 or newer
- A GPU-enabled PyTorch build for your platform
- One of: an NVIDIA GPU with its driver (Linux or Windows), an AMD GPU with ROCm
  (Linux only), or an Apple Silicon Mac (macOS)

## Python environment with Miniforge

Miniforge installs conda with the conda-forge channel and keeps the model's
packages separate from the rest of your system.

=== "Linux / macOS"

    ```bash
    curl -L -O "https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-$(uname)-$(uname -m).sh"
    bash Miniforge3-$(uname)-$(uname -m).sh
    ```

    Restart your shell when the installer finishes.

=== "Windows"

    Download `Miniforge3-Windows-x86_64.exe` from the
    [miniforge releases page](https://github.com/conda-forge/miniforge/releases/latest)
    and run it. Use the "Miniforge Prompt" for the commands below.

Create and activate an environment. Use the newest Python release that has PyTorch
wheels (see the [PyTorch install page](https://pytorch.org/get-started/locally/)).

```bash
conda create -n CMF python=3.14
conda activate CMF
```

## GPU driver and toolkit

### NVIDIA

Install the latest driver for your GPU and check that `nvidia-smi` works. PyTorch
ships the CUDA runtime, so the default Triton backend runs with nothing else
installed; the CUDA Toolkit below adds step replay. After
installing PyTorch (next section), print the CUDA version it was built with:

```bash
python -c "import torch; print(torch.version.cuda)"
```

#### CUDA Toolkit (for the `cuda` backend and step replay)

The `cuda` backend (`HYDROFORGE_BACKEND=cuda`) compiles its GPU code at start-up
with NVIDIA's run-time compiler (NVRTC), which needs the CUDA Toolkit headers.
With any backend, recording a step's GPU work once and replaying it (CUDA graphs,
see `execution_mode` in [Configuration](run/configuration.md)) also needs the
toolkit headers, and CUDA 12.4 or newer in both toolkit and driver; without them
the model launches each kernel separately. PyTorch finds the headers through
`torch.utils.cpp_extension.CUDA_HOME`, set from `CUDA_HOME`, `CUDA_PATH` or `nvcc`
on your `PATH`. Install the toolkit one of two ways:

a) Install the official [NVIDIA CUDA Toolkit](https://developer.nvidia.com/cuda-downloads)
   with the same major version as `torch.version.cuda`. On Linux:

   ```bash
   export CUDA_HOME=/usr/local/cuda-13.x
   export PATH=$CUDA_HOME/bin:$PATH
   ```

   On Windows the installer sets `CUDA_PATH`.

b) Install it with pip (CUDA 13 wheels, Linux example):

   ```bash
   pip install "nvidia-cuda-cccl==13.*" "nvidia-cuda-nvcc==13.*"
   export CUDA_HOME="$(python -c "import nvidia, os; print(os.path.dirname(nvidia.__path__[0]))")/nvidia/cu13"
   ```

Check that PyTorch finds it:

```bash
python -c "from torch.utils.cpp_extension import CUDA_HOME; print(CUDA_HOME)"
```

### Windows with WSL2

Install the Windows NVIDIA driver, then follow the Linux instructions inside WSL2.
Do not install a Linux display driver inside WSL.

### Windows (native)

- Install the Windows NVIDIA driver, a PyTorch CUDA wheel and
  `pip install triton-windows` for the default Triton backend.
- For the `cuda` backend, the CUDA Toolkit installer sets `CUDA_PATH`.
- Write paths in scripts as raw strings (`fr"C:\..."`).
- Multi-GPU runs need the NCCL library, which native Windows lacks. Use WSL2 or
  Linux for `torchrun` runs on several GPUs.

### AMD (Linux only)

Install ROCm following AMD's guide, then add your user to the `render` and `video`
groups:

```bash
sudo usermod -aG render,video $USER
```

Check the installation with `rocminfo` or `rocm-smi`. Consumer GPUs missing from
ROCm's official list may need `export HSA_OVERRIDE_GFX_VERSION=...` (`11.0.0` for
RDNA3, `10.3.0` for RDNA2); this is an unsupported workaround. PyTorch's ROCm
builds expose an AMD GPU as device type `cuda`, so the scripts run unchanged. The
default backend is Triton; `HYDROFORGE_BACKEND=cuda` compiles with AMD's hiprtc
instead of NVRTC.

### macOS

The Metal backend runs on Apple Silicon Macs through PyTorch's MPS device. Nothing
extra to install; Triton is not used. Some Apple GPUs and macOS versions may not be
supported.

## PyTorch

Pick the build for your GPU on
[pytorch.org/get-started/locally/](https://pytorch.org/get-started/locally/).
Examples:

=== "NVIDIA"

    ```bash
    pip install torch --index-url https://download.pytorch.org/whl/cu132
    ```

=== "AMD"

    ```bash
    pip install torch --index-url https://download.pytorch.org/whl/rocm<version>
    ```

    Take the ROCm index URL from the PyTorch page.

=== "macOS"

    ```bash
    pip install torch
    ```

For V100 and other compute capability 7.0 (sm_70) GPUs, PyTorch 2.11.0 and later
drop support. Install:

```bash
pip install torch==2.10.0 --index-url https://download.pytorch.org/whl/cu128
```

You do not need `torchvision` or `torchaudio`.

## Triton

Triton compiles the default GPU backend. On Linux (CUDA and ROCm) it usually comes
with PyTorch. Check:

```bash
python -c "import triton"
```

On native Windows install it with `pip install triton-windows`
([triton-windows](https://github.com/triton-lang/triton-windows)). macOS does not
need it.

## HydroForge and CaMa-Flood-GPU

HydroForge is the framework under CaMa-Flood-GPU: input loading, GPU code
generation, multi-GPU partitioning and output. Install it, then the model:

```bash
pip install git+https://github.com/Kshy0/hydroforge.git
git clone https://github.com/Kshy0/CaMa-Flood-GPU.git
cd CaMa-Flood-GPU
pip install -e .
```

The two projects evolve together. To update, run `git pull` in the CaMa-Flood-GPU
folder and reinstall HydroForge:

```bash
pip install --upgrade --force-reinstall --no-deps git+https://github.com/Kshy0/hydroforge.git
```

## Check the installation

```python
import torch
print(torch.__version__)
print("cuda:", torch.cuda.is_available())
print("mps:", torch.backends.mps.is_available())
import cmfgpu, hydroforge
```

`cuda: True` means an NVIDIA or AMD GPU is usable; `mps: True` means an Apple GPU is
usable.

## Choosing a backend

The *backend* turns the model's physics into GPU code. CaMa-Flood-GPU ships
kernels for three backends: Triton, CUDA and Metal. Without `HYDROFORGE_BACKEND`,
the model picks Triton on NVIDIA and AMD GPUs and Metal on Apple GPUs. Set the
variable to override.

| `HYDROFORGE_BACKEND` | what it is | notes |
|---|---|---|
| `triton` | GPU code generated by Triton | Default on NVIDIA and AMD GPUs |
| `cuda` | CUDA C++ compiled at start-up with NVRTC (hiprtc on AMD) | Needs the CUDA Toolkit on NVIDIA; works on AMD when selected |
| `metal` | Metal shaders through PyTorch MPS | Default on Apple Silicon; `precision="float32"` only |

HydroForge also has a plain-PyTorch `torch` backend, its default on a CPU, but
CaMa-Flood-GPU has no kernels for it. Run the model on a GPU.

Apple GPUs have no 64-bit floating point. With mixed precision, which
CaMa-Flood-GPU switches on by default on Metal as on NVIDIA and AMD, the Metal
backend stores water volumes as two 32-bit numbers (a value and its rounding
error). This emulated double precision keeps about 48 significant bits (real
64-bit keeps 53) and is chosen by `metal_emulation="auto"` in `CaMaFlood(...)`.

There is no build step. GPU code is compiled the first time it is needed and cached
on disk, so the first run in a new environment starts slower.
