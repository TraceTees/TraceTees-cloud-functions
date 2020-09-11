import * as admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
});

import * as firebaseFunctions from "./firebaseFunctions";
import config from "./config";

import getHandshakePin from "./opentrace/getHandshakePin";
import getTempIDs from "./opentrace/getTempIDs";
import getUploadToken from "./opentrace/getUploadToken";
import processUploadedData from "./opentrace/processUploadedData";
import getContacts from "./opentrace/getContacts";

exports.getHandshakePin = firebaseFunctions.https(getHandshakePin);
exports.getTempIDs = firebaseFunctions.https(getTempIDs);
exports.getUploadToken = firebaseFunctions.https(getUploadToken);
exports.getContacts = firebaseFunctions.https(getContacts);
exports.processUploadedData = firebaseFunctions.storage(
  config.upload.bucket,
  processUploadedData
);
