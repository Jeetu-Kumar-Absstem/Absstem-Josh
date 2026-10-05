async function createOwnedAttachment(
  client,
  {
    fileName,
    filePath,
    mimeType,
    fileSizeBytes,
    uploadedBy,
    companyId = null,
    ownerType = "legacy",
    ownerId = null,
    visibilityScope = companyId ? "company" : "global",
  }
) {
  const normalizedCompanyId = Number.isFinite(Number(companyId)) ? Number(companyId) : null;
  const normalizedOwnerId = Number.isFinite(Number(ownerId)) ? Number(ownerId) : null;
  const scope = normalizedCompanyId ? "company" : visibilityScope === "global" ? "global" : "company";
  const { rows } = await client.query(
    `
      insert into attachments (
        file_name,
        file_path,
        mime_type,
        file_size_bytes,
        uploaded_by,
        company_id,
        owner_type,
        owner_id,
        visibility_scope
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      returning id, file_name
    `,
    [
      fileName,
      filePath,
      mimeType || "application/octet-stream",
      Number(fileSizeBytes || 0) || 0,
      uploadedBy || null,
      normalizedCompanyId,
      ownerType || "legacy",
      normalizedOwnerId,
      scope,
    ]
  );
  return rows[0] || null;
}

module.exports = {
  createOwnedAttachment,
};
