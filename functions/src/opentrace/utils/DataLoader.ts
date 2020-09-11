import * as admin from "firebase-admin";
import config from "../../config";
import formatTimestamp from "./formatTimestamp";

/**
 * Store upload logs in a Firebase database
 * @param id
 * @param log
 */
export async function storeContact(id: string, data: object) {
  const writeResult = await admin
    .firestore()
    .collection(config.upload.uploadDBCollection)
    .doc("contacts")
    .set(data);
  console.log(
    "uploadDBCollection:",
    "upload is recorded successfully at",
    formatTimestamp(writeResult.writeTime.seconds)
  );
}
