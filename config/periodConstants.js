const PERIOD_COLORS = {
    RED_FRESH: {
      code: "RED_FRESH",
      label: "鲜红色",
      meaning: "正常，经期中后段"
    },
    RED_DARK: {
      code: "RED_DARK",
      label: "暗红色",
      meaning: "正常，经期初/末期"
    },
    BROWN: {
      code: "BROWN",
      label: "深褐色",
      meaning: "作息/压力影响"
    },
    PINK: {
      code: "PINK",
      label: "粉红色",
      meaning: "警惕激素低"
    },
    ORANGE: {
      code: "ORANGE",
      label: "橙红色",
      meaning: "警惕感染"
    },
    BLACK: {
      code: "BLACK",
      label: "黑色",
      meaning: "淤积严重"
    }
  };
  
  // 导出所有合法的 Key，用于模型校验
  const VALID_COLOR_CODES = Object.keys(PERIOD_COLORS);
  
  module.exports = {
    PERIOD_COLORS,
    VALID_COLOR_CODES
  };