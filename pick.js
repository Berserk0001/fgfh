/**
 * Picks specific properties from an object.
 * @param {Object} object - The source object.
 * @param {Array} properties - The list of properties to pick.
 * @returns {Object} - The new object with only the picked properties.
 */
const pick = (object, properties) => {
  return Object.entries(object || {}).reduce((picked, [key, value]) => {
    if (properties.includes(key)) {
      picked[key] = value;
    }
    return picked;
  }, {});
};

export default pick;
