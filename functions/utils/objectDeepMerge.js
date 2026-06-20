/**
 * @fileoverview Deep-merge plain objects for partial Firestore PATCH updates.
 * Arrays and non-plain values in the patch replace the target value.
 */

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    (typeof value.toDate !== "function")
  );
}

/**
 * Deep-merge patch into base. Patch wins on conflicts; nested plain objects merge.
 *
 * @param {unknown} base
 * @param {unknown} patch
 * @returns {unknown}
 */
function deepMerge(base, patch) {
  if (patch === undefined) {
    return base;
  }
  if (patch === null || !isPlainObject(patch)) {
    return patch;
  }
  if (!isPlainObject(base)) {
    return deepMerge({}, patch);
  }

  /** @type {Record<string, unknown>} */
  const out = {...base};
  for (const [key, patchValue] of Object.entries(patch)) {
    if (patchValue === undefined) {
      continue;
    }
    const baseValue = out[key];
    if (isPlainObject(baseValue) && isPlainObject(patchValue)) {
      out[key] = deepMerge(baseValue, patchValue);
    } else {
      out[key] = patchValue;
    }
  }
  return out;
}

module.exports = {
  deepMerge,
  isPlainObject,
};
