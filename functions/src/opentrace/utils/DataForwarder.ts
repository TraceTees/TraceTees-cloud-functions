import StreetPassRecord from "../types/StreetPassRecord";
import HeartBeatEvent from "../types/HeartBeatEvent";

import { storeContact } from "./DataLoader";

/**
 * Create a subclass of this class and use it in config.*.ts
 */
export default class DataForwarder {
  async forwardData(
    filePath: string,
    id: string,
    uploadCode: string,
    records: StreetPassRecord[],
    events: HeartBeatEvent[]
  ): Promise<void> {
    await storeContact(id, { records });
    return;
  }
}
