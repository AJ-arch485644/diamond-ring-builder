'use strict';

// The same customer-facing name is used for pre-created owned stones and
// supplier diamonds created at cart time. Stock identity stays in variant.sku.
function diamondTitle(diamond) {
  const carat = Number(diamond.carat);
  if (!Number.isFinite(carat) || carat <= 0 || carat > 100 ||
      !['shape', 'color', 'clarity'].every(key => typeof diamond[key] === 'string' && diamond[key].trim() && !/[\x00-\x1f\x7f]/.test(diamond[key]))) {
    throw new Error('INVALID_DIAMOND_TITLE_FACTS');
  }
  return `${carat}ct ${diamond.shape.trim()} ${diamond.color.trim()} ${diamond.clarity.trim()} Lab Diamond`;
}

module.exports = { diamondTitle };
