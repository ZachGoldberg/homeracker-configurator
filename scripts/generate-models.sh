#!/usr/bin/env bash
#
# Generate GLB models from OpenSCAD sources for the web configurator.
#
# Prerequisites:
#   - OpenSCAD installed (via scadm in the homeracker repo)
#   - Python 3 with trimesh: pip install trimesh numpy
#
# Usage:
#   ./scripts/generate-models.sh [path-to-homeracker-repo]
#
# The homeracker repo path defaults to ../homeracker (sibling directory).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
HOMERACKER_REPO="${1:-$(cd "${PROJECT_ROOT}/../homeracker" && pwd)}"

OPENSCAD="${HOMERACKER_REPO}/bin/openscad/openscad"
OPENSCADPATH="${HOMERACKER_REPO}/bin/openscad/libraries"
MANIFEST="${SCRIPT_DIR}/model-manifest.json"
STL_DIR="${PROJECT_ROOT}/tmp-stl"
GLB_DIR="${PROJECT_ROOT}/public/models"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${YELLOW}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check prerequisites
if [[ ! -f "${OPENSCAD}" ]]; then
    log_error "OpenSCAD not found at ${OPENSCAD}"
    log_info "Run 'scadm install' in the homeracker repo first."
    exit 1
fi

if ! python3 -c "import trimesh" 2>/dev/null; then
    log_error "Python trimesh not found. Install with: pip install trimesh numpy"
    exit 1
fi

if ! command -v jq &>/dev/null; then
    log_error "jq not found. Install with: apt install jq"
    exit 1
fi

# Create output directories
mkdir -p "${STL_DIR}" "${GLB_DIR}"

# Determine if we need xvfb-run (headless Linux)
OPENSCAD_CMD="${OPENSCAD}"
if [[ "$(uname -s)" == "Linux" ]] && command -v xvfb-run &>/dev/null; then
    OPENSCAD_CMD="xvfb-run -a ${OPENSCAD}"
fi

render_count=0
fail_count=0

# Process each category in the manifest
for category in supports connectors lockpins; do
    items=$(jq -r ".${category}[] | @base64" "${MANIFEST}")

    for item_b64 in ${items}; do
        item=$(echo "${item_b64}" | base64 --decode)
        id=$(echo "${item}" | jq -r '.id')
        scad_file="${HOMERACKER_REPO}/$(echo "${item}" | jq -r '.scad')"
        stl_file="${STL_DIR}/${id}.stl"
        glb_file="${GLB_DIR}/${id}.glb"

        # Build -D parameter string
        params_json=$(echo "${item}" | jq -c '.params')
        d_args=""
        for key in $(echo "${params_json}" | jq -r 'keys[]'); do
            value=$(echo "${params_json}" | jq -r ".${key}")
            # Quote string values, leave numbers/booleans as-is
            # String quotes must survive eval, so double-escape them
            if echo "${params_json}" | jq -e ".${key} | type == \"string\"" >/dev/null 2>&1; then
                d_args="${d_args} -D ${key}=\\\"${value}\\\""
            else
                d_args="${d_args} -D ${key}=${value}"
            fi
        done

        log_info "Rendering ${id}..."

        # Render STL
        if eval OPENSCADPATH="${OPENSCADPATH}" ${OPENSCAD_CMD} \
            -o "${stl_file}" \
            ${d_args} \
            "${scad_file}" \
            --export-format=binstl 2>/tmp/openscad-gen.log; then

            if [[ -f "${stl_file}" ]]; then
                # Convert STL to GLB
                python3 "${SCRIPT_DIR}/stl-to-glb.py" "${stl_file}" "${glb_file}" "${category}"
                if [[ -f "${glb_file}" ]]; then
                    file_size=$(stat -c%s "${glb_file}" 2>/dev/null || stat -f%z "${glb_file}" 2>/dev/null)
                    log_success "${id}.glb (${file_size} bytes)"
                    render_count=$((render_count + 1))
                else
                    log_error "GLB conversion failed for ${id}"
                    fail_count=$((fail_count + 1))
                fi
            else
                log_error "No STL output for ${id}"
                cat /tmp/openscad-gen.log
                fail_count=$((fail_count + 1))
            fi
        else
            log_error "OpenSCAD render failed for ${id}"
            cat /tmp/openscad-gen.log
            fail_count=$((fail_count + 1))
        fi
    done
done

# Cleanup temp STL files
rm -rf "${STL_DIR}"
rm -f /tmp/openscad-gen.log

echo ""
if [[ ${fail_count} -gt 0 ]]; then
    log_error "${fail_count} model(s) failed, ${render_count} succeeded"
    exit 1
else
    log_success "All ${render_count} models generated successfully in ${GLB_DIR}/"
fi
