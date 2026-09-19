/**
 * The frame size an H.264 stream actually carries, read from its SPS.
 *
 * The agent announces a size with each layout, and for a single monitor that
 * is the monitor's LOGICAL size. On a scaled display those differ: the HP box's
 * panel is 1920x1080 at 125%, mutter records it at 1920x1080, and the agent
 * announced 1536x864. The canvas path draws each frame scaled into whatever
 * size it was told, so it looked fine. The Media Source path writes that size
 * into the MP4 container, and Safari then shows only the declared 1536x864 of
 * every 1920x1080 frame — the bottom and right fifth of the screen simply
 * missing, on iPhone only.
 *
 * The SPS is the one statement about the frame size that cannot disagree with
 * the frames, so the player sizes itself from this and the announcement is
 * only a fallback.
 */

/** Strip emulation-prevention bytes (00 00 03 -> 00 00) to get the RBSP. */
function rbsp(nal) {
  const out = [];
  for (let i = 0; i < nal.length; i += 1) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    out.push(nal[i]);
  }
  return out;
}

class Bits {
  constructor(bytes) { this.b = bytes; this.i = 0; }

  u(n) {
    let v = 0;
    for (let k = 0; k < n; k += 1) {
      const byte = this.b[this.i >> 3];
      if (byte === undefined) throw new Error('SPS ended early');
      v = (v << 1) | ((byte >> (7 - (this.i & 7))) & 1);
      this.i += 1;
    }
    return v >>> 0;
  }

  ue() {                                   // Exp-Golomb, unsigned
    let zeros = 0;
    while (this.u(1) === 0) {
      zeros += 1;
      if (zeros > 31) throw new Error('bad Exp-Golomb code');
    }
    return zeros ? (2 ** zeros - 1) + this.u(zeros) : 0;
  }

  se() {                                   // Exp-Golomb, signed
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -(k / 2);
  }
}

// Profiles whose SPS carries chroma format, bit depth and scaling lists.
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

function skipScalingList(bits, size) {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size; j += 1) {
    if (next !== 0) next = (last + bits.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

/**
 * @param {Uint8Array} sps  one SPS NAL unit, header byte included (type 7)
 * @returns {{w: number, h: number} | null}  null if it cannot be read
 */
export function spsSize(sps) {
  try {
    if (!sps || sps.length < 4 || (sps[0] & 0x1f) !== 7) return null;
    const bits = new Bits(rbsp(sps.subarray ? sps.subarray(1) : sps.slice(1)));
    const profile = bits.u(8);
    bits.u(8);                             // constraint flags
    bits.u(8);                             // level
    bits.ue();                             // seq_parameter_set_id

    let chroma = 1;                        // 4:2:0 unless the SPS says otherwise
    if (HIGH_PROFILES.has(profile)) {
      chroma = bits.ue();
      if (chroma === 3) bits.u(1);         // separate_colour_plane_flag
      bits.ue();                           // bit_depth_luma_minus8
      bits.ue();                           // bit_depth_chroma_minus8
      bits.u(1);                           // qpprime_y_zero_transform_bypass
      if (bits.u(1)) {                     // seq_scaling_matrix_present
        for (let i = 0; i < (chroma !== 3 ? 8 : 12); i += 1) {
          if (bits.u(1)) skipScalingList(bits, i < 6 ? 16 : 64);
        }
      }
    }

    bits.ue();                             // log2_max_frame_num_minus4
    const pocType = bits.ue();
    if (pocType === 0) {
      bits.ue();                           // log2_max_pic_order_cnt_lsb_minus4
    } else if (pocType === 1) {
      bits.u(1);
      bits.se();
      bits.se();
      const n = bits.ue();
      for (let i = 0; i < n; i += 1) bits.se();
    }
    bits.ue();                             // max_num_ref_frames
    bits.u(1);                             // gaps_in_frame_num_allowed

    const widthMbs = bits.ue() + 1;
    const heightUnits = bits.ue() + 1;
    const frameMbsOnly = bits.u(1);
    if (!frameMbsOnly) bits.u(1);          // mb_adaptive_frame_field
    bits.u(1);                             // direct_8x8_inference

    let crop = [0, 0, 0, 0];
    if (bits.u(1)) crop = [bits.ue(), bits.ue(), bits.ue(), bits.ue()];

    // Crop offsets count in chroma samples, not pixels (7.4.2.1.1).
    const subW = chroma === 1 || chroma === 2 ? 2 : 1;
    const subH = chroma === 1 ? 2 : 1;
    const unitX = chroma === 0 ? 1 : subW;
    const unitY = (chroma === 0 ? 1 : subH) * (2 - frameMbsOnly);

    const w = widthMbs * 16 - (crop[0] + crop[1]) * unitX;
    const h = (2 - frameMbsOnly) * heightUnits * 16 - (crop[2] + crop[3]) * unitY;
    return w > 0 && h > 0 ? { w, h } : null;
  } catch {
    return null;
  }
}
