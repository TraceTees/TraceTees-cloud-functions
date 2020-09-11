import * as admin from "firebase-admin";
import config from "../config";
import * as moment from "moment";
/**
 * Get the contacts.
 */
const getContacts = async (uid: string) => {
  const recordsFromDb = await admin
    .firestore()
    .collection(config.upload.uploadDBCollection)
    .doc("contacts")
    .get();
  const currentDate = moment().unix();
  const data = (recordsFromDb.data() || { records: [{}] }).records.filter(
    (record: any) => {
      return (
        record.contactId === uid &&
        record.contactTime >= 900 &&
        currentDate - record.contactIdValidTo <= 1296000
      );
    }
  );
  const payload = JSON.stringify({
    records: data,
  });
  return {
    status: "SUCCESS",
    payload,
  };
};

export default getContacts;
