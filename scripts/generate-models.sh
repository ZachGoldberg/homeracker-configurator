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

# ---------------------------------------------------------------------------
# Convert raw models (STL, 3MF, OBJ, etc.) from raw-models/ directory
# Multi-geometry files (e.g. 3MF) are split into individual GLBs, grouped
# under the source filename in the manifest.
# ---------------------------------------------------------------------------
RAW_MODELS_DIR="${PROJECT_ROOT}/raw-models"
RAW_MANIFEST="${PROJECT_ROOT}/src/data/raw-models-manifest.json"
raw_count=0

if [[ -d "${RAW_MODELS_DIR}" ]]; then
    log_info "Processing raw models from ${RAW_MODELS_DIR}..."

    # Collect JSON entries — each is a flat object with optional "group" field
    manifest_entries=()

    for raw_file in "${RAW_MODELS_DIR}"/*.{stl,STL,3mf,3MF,obj,OBJ,ply,PLY,off,OFF}; do
        [[ -f "${raw_file}" ]] || continue

        filename=$(basename "${raw_file}")
        name_no_ext="${filename%.*}"
        # Clean display name: replace + with space, collapse whitespace
        display_name=$(echo "${name_no_ext}" | sed 's/+-+/ - /g; s/+/ /g; s/  */ /g; s/^ //; s/ $//')
        # Sanitize to ID prefix: lowercase, replace non-alphanumeric with hyphens
        id_base="other-$(echo "${name_no_ext}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')"

        log_info "Converting raw model: ${filename} (split mode)..."

        # Use --split to export each geometry as a separate GLB
        if ! split_json=$(python3 "${SCRIPT_DIR}/stl-to-glb.py" --split "${raw_file}" "${GLB_DIR}/${id_base}" "other" 2>/tmp/split-convert.log); then
            log_error "Failed to convert ${filename}"
            cat /tmp/split-convert.log
            fail_count=$((fail_count + 1))
            continue
        fi

        # Parse the JSON array of split results
        num_parts=$(echo "${split_json}" | jq 'length')

        if [[ "${num_parts}" -le 0 ]]; then
            log_error "No geometries found in ${filename}"
            fail_count=$((fail_count + 1))
            continue
        fi

        for idx in $(seq 0 $((num_parts - 1))); do
            part_file=$(echo "${split_json}" | jq -r ".[$idx].file")
            part_index=$(echo "${split_json}" | jq -r ".[$idx].index")

            part_id="${id_base}-${part_index}"
            full_path="${GLB_DIR}/${part_file}"

            if [[ -f "${full_path}" ]]; then
                file_size=$(stat -c%s "${full_path}" 2>/dev/null || stat -f%z "${full_path}" 2>/dev/null)
                log_success "${part_file} (${file_size} bytes)"

                # For multi-part files: name is "Part N", with group = display_name
                # For single-part files: name is display_name, no group
                if [[ "${num_parts}" -gt 1 ]]; then
                    manifest_entries+=("{\"id\":\"${part_id}\",\"name\":\"Part ${part_index}\",\"file\":\"${part_file}\",\"group\":\"${display_name}\"}")
                else
                    manifest_entries+=("{\"id\":\"${part_id}\",\"name\":\"${display_name}\",\"file\":\"${part_file}\"}")
                fi

                raw_count=$((raw_count + 1))
                render_count=$((render_count + 1))
            else
                log_error "Expected output ${part_file} not found"
                fail_count=$((fail_count + 1))
            fi
        done
    done

    rm -f /tmp/split-convert.log

    # Write manifest JSON
    if [[ ${#manifest_entries[@]} -gt 0 ]]; then
        printf "[\n" > "${RAW_MANIFEST}"
        for i in "${!manifest_entries[@]}"; do
            if [[ $i -lt $((${#manifest_entries[@]} - 1)) ]]; then
                printf "  %s,\n" "${manifest_entries[$i]}" >> "${RAW_MANIFEST}"
            else
                printf "  %s\n" "${manifest_entries[$i]}" >> "${RAW_MANIFEST}"
            fi
        done
        printf "]\n" >> "${RAW_MANIFEST}"
        log_success "Raw models manifest: ${RAW_MANIFEST} (${#manifest_entries[@]} entries)"
    else
        printf "[]\n" > "${RAW_MANIFEST}"
    fi

    if [[ ${raw_count} -gt 0 ]]; then
        log_success "${raw_count} raw model(s) converted"
    fi
else
    # No raw-models directory — write empty manifest
    printf "[]\n" > "${RAW_MANIFEST}"
fi

echo ""
if [[ ${fail_count} -gt 0 ]]; then
    log_error "${fail_count} model(s) failed, ${render_count} succeeded"
    exit 1
else
    log_success "All ${render_count} models generated successfully in ${GLB_DIR}/"
fi
