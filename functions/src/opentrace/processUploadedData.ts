import * as admin from "firebase-admin";
import * as functions from "firebase-functions";
import * as moment from "moment";
import * as path from "path";

import StreetPassRecord from "./types/StreetPassRecord";
import config from "../config";

import { decryptTempID } from "./getTempIDs";
import { validateToken } from "./getUploadToken";
import { getAllEncryptionKeys } from "./utils/getEncryptionKey";
import formatTimestamp from "./utils/formatTimestamp";
import { storeUploadLog } from "./utils/AuditLogger";

/**
 * Process user's uploaded data.
 *
 * Most important tasks:
 *  + Validate upload token to get uid
 *  + Post-process records (e.g., validate exchanged messages, decrypt TempIDs)
 *  + Forward data for further processing
 */
export default async function processUploadedData(
  object: functions.storage.ObjectMetadata
) {
  const filePath = object.name;

  console.log("processUploadedData:", "Detected new file:", filePath);

  if (
    filePath !== undefined &&
    filePath.startsWith(config.upload.recordsDir) &&
    filePath.endsWith(".json")
  ) {
    const fileName = path.basename(filePath, ".json");
    let archiveFilePath = filePath;
    console.log(
      "processUploadedData:",
      "File is streetPassRecords, content type:",
      object.contentType
    );
    await storeUploadLog(fileName, {
      fileName: fileName,
      status: "STARTED",
      loggedTime: Date.now() / 1000,
    });

    const step = "0 - move file";
    try {
      const uploadFile = admin.storage().bucket(object.bucket).file(filePath);
      console.log(
        "processUploadedData:",
        "Uploaded file md5Hash",
        object.md5Hash
      );

      //
      // Step 0: Move file to archive bucket
      //
      if (!archiveFilePath.startsWith(`${config.upload.recordsDir}/20`)) {
        // Put file into date folder if filepath doesn't contain date
        archiveFilePath = archiveFilePath.replace(
          config.upload.recordsDir,
          `${config.upload.recordsDir}/${formatTimestamp(
            moment().unix(),
            "YYYYMMDD"
          )}`
        );
      }
      const archivedFile = admin
        .storage()
        .bucket(config.upload.bucketForArchive)
        .file(archiveFilePath);
      await uploadFile.copy(archivedFile);
      await uploadFile.delete();
      console.log(
        "processUploadedData:",
        `"step ${step}"`,
        "Uploaded file has been moved to archive folder."
      );
    } catch (error) {
      console.error(
        new Error(
          `processUploadedData: "step ${step}" Error encountered, message: ${error.message}. Stack trace:\n${error.stack}`
        )
      );
      await storeUploadLog(fileName, {
        fileName: fileName,
        id: "",
        status: "ERROR",
        step: step,
        errorMessage: error.message,
        errorStackTrace: error.stack,
        loggedTime: Date.now() / 1000,
      });

      return {
        status: "ERROR",
      };
    }

    return _processUploadedData(archiveFilePath);
  } else {
    console.log(
      "processUploadedData:",
      "File is not streetPassRecords, ignore."
    );

    return {
      status: "NONE",
    };
  }
}

export async function _processUploadedData(
  filePath: string,
  validateTokenTimestamp: boolean = true
): Promise<{ status: string; message?: string; filePath?: string }> {
  const fileName = path.basename(filePath, ".json");
  let uid = "",
    uploadCode = "",
    step = "";

  try {
    //
    // Step 1: load file content into memory
    //
    step = "1 - load file";
    const { token, records, events } = JSON.parse(
      await getStorageData(config.upload.bucketForArchive, filePath)
    );
    console.log(
      "processUploadedData:",
      `"step ${step}"`,
      "File is loaded, record count:",
      records.length
    );

    //
    // Step 2: Validate upload token to get uid
    //
    step = "2 - validate upload token";
    ({ uid, uploadCode } = await validateToken(token, validateTokenTimestamp));
    console.log(
      "processUploadedData:",
      `"step ${step}"`,
      "Upload token is valid, id:",
      uid
    );

    //
    // Step 3: Post-process records (e.g., validate, decrypt the contact's phone number)
    //
    step = "3 - post-process records";
    const validatedRecords = await validateRecords(records);
    console.log(
      "processUploadedData:",
      `"step ${step}"`,
      "Complete validation of records,",
      "original count:",
      records.length,
      "after validation:",
      validatedRecords.length
    );

    //
    // Step 4: Forward validated data for further processing
    //
    step = "Step 4 - forward data";
    console.log(`"step ${step}"`);
    await config.upload.dataForwarder.forwardData(
      filePath,
      uid,
      uploadCode,
      validatedRecords,
      events
    );

    //
    // Step 5: Create an audit record and store in a Firebase Database
    //
    await storeUploadLog(fileName, {
      fileName: fileName,
      id: uid,
      status: "SUCCESS",
      uploadCode: uploadCode,
      recordsReceived: records.length,
      validatedRecords: validatedRecords,
      recordsSent: validatedRecords.length,
      loggedTime: Date.now() / 1000,
    });
  } catch (error) {
    console.error(
      new Error(
        `processUploadedData: "step ${step}" Error encountered, message: ${error.message}. Stack trace:\n${error.stack}`
      )
    );
    await storeUploadLog(fileName, {
      fileName: fileName,
      id: uid,
      status: "ERROR",
      uploadCode: uploadCode,
      step: step,
      errorMessage: error.message,
      errorStackTrace: error.stack,
      loggedTime: Date.now() / 1000,
    });

    return {
      status: "ERROR",
      message: error.message,
    };
  }

  return {
    status: "SUCCESS",
    filePath: filePath,
  };
}

/**
 * Get data from storage bucket
 * @param bucket
 * @param filePath
 */
async function getStorageData(bucket: string, filePath: string) {
  const archivedFile = admin.storage().bucket(bucket).file(filePath);
  return archivedFile.download().then((_) => _.toString());
}

/**
 * Validate records and convert temp ID to UID
 */
async function validateRecords(
  records: StreetPassRecord[]
): Promise<StreetPassRecord[]> {
  if (!records) {
    return [];
  }
  // Get a database reference to our posts
  // const db = admin.database();
  // const ref = db.ref("server/saving-data/fireblog/posts");

  // // Attach an asynchronous callback to read the data at our posts reference
  // ref.on("value", (snapshot) => {
  //   if (snapshot) {
  //     console.log(snapshot.val());
  //   }
  // });

  const oldRecordsSnap = await admin
    .firestore()
    .collection(config.upload.uploadDBCollection)
    .doc("contacts")
    .get();

  const encryptionKeys = await getAllEncryptionKeys();

  records.forEach((record) => {
    record.timestamp =
      record.timestamp > 10000000000
        ? record.timestamp / 1000
        : record.timestamp; // Convert Epoch ms to Epoch s
    record.timestampString = formatTimestamp(record.timestamp);
    validateRecord(record, encryptionKeys);
  });

  let newRecords: StreetPassRecord[] = [];
  records.sort((a, b) => {
    return (b.contactIdValidFrom || 0) - (a.contactIdValidFrom || 0);
  });
  for (let i = 0; i < records.length; i += 1) {
    console.log("contactIdValidTo", records[i].contactIdValidTo);
    console.log("contactIdValidFrom", records[i].contactIdValidFrom);
  }

  if (records.length > 0) {
    // set of contact_ids
    const contactIdsSet: String[] = [];
    for (let i = 0; i < records.length; i += 1) {
      if (!contactIdsSet.includes(records[i].contactId || "")) {
        contactIdsSet.push(records[i].contactId || "");
      }
    }
    // for each contact id in set
    for (let i = 0; i < contactIdsSet.length; i += 1) {
      // filter records by contact id
      const filteredRecords = records.filter((item) => {
        return item.contactId === contactIdsSet[i];
      });
      // sort record by timestamp
      filteredRecords.sort((a, b) => {
        return (a.timestamp || 0) - (b.timestamp || 0);
      });
      let contactTime = 0;
      // manipulation with this records
      for (let j = 1; j < filteredRecords.length; j += 1) {
        if (filteredRecords[j].timestamp && filteredRecords[j - 1].timestamp) {
          let difference =
            filteredRecords[j].timestamp - filteredRecords[j - 1].timestamp;
          if (difference < 600) {
            contactTime += difference;
          }
        }
      }
      newRecords.push({
        ...filteredRecords[0],
        contactTime,
      });
    }

    //   newRecords.push({
    //     ...records[0],
    //     contactTime: 300,
    //   });
    //   for (let i = 1; i < records.length; i += 1) {
    //     let flag = false;
    //     let track_j = 0;
    //     for (let j = 0; j < newRecords.length; j += 1) {
    //       if (newRecords[j].contactId === records[i].contactId) {
    //         flag = true;
    //         track_j = j;
    //       }
    //     }
    //     const contactTime =
    //       (records[i].contactIdValidTo || 0) -
    //       (records[i].contactIdValidFrom || 0);
    //     if (flag) {
    //       if (
    //         newRecords[track_j].contactIdValidTo !==
    //           records[i].contactIdValidTo &&
    //         newRecords[track_j].contactIdValidFrom !==
    //           records[i].contactIdValidFrom
    //       ) {
    //         newRecords[track_j].contactIdValidTo = records[i].contactIdValidTo;
    //         newRecords[track_j].contactIdValidFrom =
    //           records[i].contactIdValidFrom;
    //         if (newRecords[track_j].contactTime === 300) {
    //           newRecords[track_j].contactTime = 0;
    //         }
    //         newRecords[track_j].contactTime =
    //           (newRecords[track_j].contactTime || 0) + contactTime;
    //         if (newRecords[track_j].rssi < records[i].rssi) {
    //           newRecords[track_j].rssi = records[i].rssi;
    //         }
    //       }
    //       flag = false;
    //     } else {
    //       newRecords.push({ ...records[i], contactTime });
    //     }
    //   }
    // }
  }
  newRecords = newRecords.concat(
    (oldRecordsSnap.data() || { records: [{ id: 1, msg: "Privet Andrei" }] })
      .records
  );

  return newRecords;
}

/**
 * Validate records by decrypting and checking if broadcast message's timestamp is within validity period.
 * Multiple encryption keys can be provided, they are tried until 1 succeeds.
 * @param record
 * @param encryptionKeys: all possible encryption keys
 */
function validateRecord(record: StreetPassRecord, encryptionKeys: Buffer[]) {
  record.isValid = false;

  if (!record.msg) {
    record.invalidReason = "no_msg";
    return;
  }

  for (const encryptionKey of encryptionKeys) {
    try {
      // Decrypt UUID
      const { uid, startTime, expiryTime } = decryptTempID(
        record.msg,
        encryptionKey
      );
      record.contactId = uid;
      record.contactIdValidFrom = startTime;
      record.contactIdValidTo = expiryTime;

      // if (record.timestamp < startTime || record.timestamp > expiryTime) {
      if (record.timestamp < startTime) {
        console.warn(
          "validateRecord:",
          "ID timestamp is not valid.",
          "ID startTime:",
          formatTimestamp(startTime),
          "ID expiryTime:",
          formatTimestamp(expiryTime),
          "timestamp:",
          formatTimestamp(record.timestamp)
        );
        record.isValid = false;
        record.invalidReason = "expired_id";
      } else {
        record.isValid = true;
      }

      break;
    } catch (error) {
      console.warn(
        "validateRecord:",
        "Error while decrypting temp ID.",
        error.message
      );
    }
  }

  if (!record.isValid && !record.invalidReason) {
    // Decryption using all encryption keys have failed. Setting the full temp ID as contactId for downstream processing.
    record.contactId = record.msg;
    record.invalidReason = "failed_decryption";
  }
}
