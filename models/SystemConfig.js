import { Schema, model } from 'mongoose';

const SystemConfigSchema = Schema({
  configKey: { type: String, required: true, unique: true },
  configValue: {
    type: Schema.Types.Mixed,
    default: () => ({
      aiServices: {
        orion_english: true, // 全局开关默认开
        ai_rpg: true,
        debater: true,
        drawing: true,
        voice2map: true 
      },
      systemMaintenance: false,
      allowNewRegistrations: true
    })
  }
});

export default model('system_configs', SystemConfigSchema);
