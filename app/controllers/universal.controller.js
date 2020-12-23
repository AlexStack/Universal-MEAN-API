const API_CONFIG = require("../config/api.config");
const db = require("../models");
const jwt = require('jsonwebtoken');

const getApiRoute = (req, res) => {
  // console.log('req.route.path',req.route.path);
  // console.log(req._parsedUrl);  
  const apiRoute = req._parsedUrl.pathname.replace('/' + API_CONFIG.API_BASE, '');
  if (apiRoute.indexOf('/search') != -1) {
    return apiRoute.split('/search')[0];
  } else if (apiRoute.indexOf('/') != -1) {
    return apiRoute.split('/')[0];
  }
  return apiRoute;
}
const getUniversalDb = (req, res) => {
  // get dynamic dbModel via api router
  return db[getApiRoute(req, res)];
}

const getApiSchema = (req, res) => {
  const apiRoute = getApiRoute(req, res);
  return API_CONFIG.API_SCHEMAS.find(apiSchema => apiSchema.apiRoute == apiRoute);
}

// Create and Save a new Universal
exports.store = async (req, res) => {
  const apiSchema = getApiSchema(req, res);
  const Universal = getUniversalDb(req, res);
  if (apiSchema.writeRules && apiSchema.writeRules.ignoreCreateAuth && !req.body[API_CONFIG.FIELD_USER_ID]) {
    // ignore auth check, allow create item anonymous. e.g. contact us form
  } else {
    const hasPermission = await hasWritePermission(apiSchema, Universal, null, req, res);
    if (!hasPermission) {
      res.status(401).send({
        message: "User do not has the permission to create new item",
      });
      return false;
    }
  }

  const universal = new Universal(req.body);
  // Save Universal in the database
  universal
    .save(universal)
    .then((data) => {
      res.send(data);
    })
    .catch((err) => {
      res.status(500).send({
        message: err.message || "Some error occurred while creating the item.",
      });
    });
};

// Retrieve all universals from the database by find()
exports.indexByFind = (req, res) => {

  // Universal = db[req.url.replace('/' + API_CONFIG.API_BASE, '')];
  const Universal = getUniversalDb(req, res);

  // console.log('===== query', req.query)
  const apiSchema = getApiSchema(req, res);
  // console.log('apiSchema=', apiSchema);

  let condition = {};
  let tempVar;
  for (paramName in req.query) {
    let paramValue = req.query[paramName];

    // Add _like to filter %keyword%, e.g. name_like=ca
    // support simple regex syntax
    // e.g.name_like=^v  name_like=n$ name_like=jack|alex  name_like=or?n
    if (paramName.indexOf('_like') != -1) {
      paramName = paramName.replace('_like', '');
      paramValue = '%' + paramValue + '%';
    }

    // Add _gte or _lte for getting a range(cannot use together yet)
    // , e.g. age_lte=60  age_gte=18
    if (paramName.indexOf('_gte') != -1) {
      paramName = paramName.replace('_gte', '');
      paramValue = '>' + paramValue;
    }
    if (paramName.indexOf('_lte') != -1) {
      paramName = paramName.replace('_lte', '');
      paramValue = '<' + paramValue;
    }

    if (paramName in apiSchema.schema) {
      if (apiSchema.schema[paramName] == String || ("type" in apiSchema.schema[paramName] && apiSchema.schema[paramName].type == String)) {
        if (paramValue.indexOf('==') === 0) {
          // e.g. title===Cat 
          // case sensitive equal match, better to set up index
          condition[paramName] = paramValue.replace('==', '');
        } else if (paramValue.substr(0, 1) == '%' && paramValue.substr(-1) == '%') {
          // e.g. title=%ca%
          // case insensitive full text match, will not use index, slow
          condition[paramName] = { $regex: new RegExp(paramValue.replace(/%/g, '')), $options: "i" };
        } else {
          // e.g. title=cat
          // case insensitive equal match, may not use the index
          // https://docs.mongodb.com/manual/reference/operator/query/regex/
          condition[paramName] = { $regex: new RegExp("^" + paramValue.toLowerCase() + "$", "i") };
        }

      } else if (apiSchema.schema[paramName] == Number || ("type" in apiSchema.schema[paramName] && apiSchema.schema[paramName].type == Number)) {
        if (paramValue.indexOf('>') === 0) {
          // e.g. age=>18
          tempVar = Number(paramValue.replace('>', ''));
          if (!isNaN(tempVar)) {
            condition[paramName] = { $gte: tempVar };
          }
        } else if (paramValue.indexOf('<') === 0) {
          // e.g. age=<18
          tempVar = Number(paramValue.replace('<', ''));
          if (!isNaN(tempVar)) {
            condition[paramName] = { $lte: tempVar };
          }
        } else if (!isNaN(paramValue)) {
          // e.g. age=18
          condition[paramName] = { $eq: paramValue };
        }
      }
    }
    // console.log(paramName, paramValue)
  }

  // find multiple ids, e.g.  ?id=1&id=2&id=3 or ?id=1,2,3,4,5
  if (req.query.id || req.query._id) {
    const originId = req.query.id ? req.query.id : req.query._id;
    const idAry = (typeof originId == 'string') ? originId.split(',') : originId;
    condition["_id"] = { "$in": idAry };
  }

  // full text search
  if (req.query.q && req.query.q.trim() != '') {
    return this.search(req, res);
  }

  console.log('find query condition:', condition);

  // Add _sort and _order (ascending order by default)
  let defaultSort = {};
  if (req.query._sort && req.query._order) {
    if (req.query._sort in apiSchema.schema) {
      defaultSort[req.query._sort] = (req.query._order == 'DESC') ? -1 : 1;
    }
  }
  if (Object.keys(defaultSort).length === 0) {
    defaultSort = { _id: -1 };
  }

  // Add _start and _end or _limit 
  let defaultSkip = 0;
  let defaultLimit = 0;
  if (req.query._start && req.query._end) {
    defaultSkip = parseInt(req.query._start);
    defaultLimit = req.query._limit ? parseInt(req.query._limit) : (parseInt(req.query._end) - parseInt(req.query._start));
  }


  let query = Universal.find(condition).sort(defaultSort);

  // only display specific fields or exclude some fields
  if (apiSchema.selectFields && apiSchema.selectFields.length > 0) {
    query.select(apiSchema.selectFields);
  }

  if (defaultSkip > 0) {
    query.skip(defaultSkip);
  }
  if (defaultLimit > 0) {
    query.limit(defaultLimit);
  }
  query.then(async (data) => {
    const totalNumber = await Universal.countDocuments(condition);
    console.log('defaultSort', defaultSort, totalNumber);
    // const totalNumber = data.length;
    res.set("Access-Control-Expose-Headers", "X-Total-Count");
    res.set("x-total-count", totalNumber);
    res.send(data);
  }).catch((err) => {
    res.status(500).send({
      message:
        err.message || "Some error occurred while retrieving items.",
    });
  });
};


// Retrieve all universals from the database by aggregate()
exports.index = async (req, res) => {

  // Universal = db[req.url.replace('/' + API_CONFIG.API_BASE, '')];
  const Universal = getUniversalDb(req, res);

  // console.log('===== query', req.query)
  const apiSchema = getApiSchema(req, res);
  // console.log('apiSchema=', apiSchema);

  let condition = {};
  let tempVar;
  for (paramName in req.query) {
    let paramValue = req.query[paramName];

    // Add _like to filter %keyword%, e.g. name_like=ca
    // support simple regex syntax
    // e.g.name_like=^v  name_like=n$ name_like=jack|alex  name_like=or?n
    if (paramName.indexOf('_like') != -1) {
      paramName = paramName.replace('_like', '');
      paramValue = '%' + paramValue + '%';
    }

    // Add _gte or _lte for getting a range(cannot use together yet)
    // , e.g. age_lte=60  age_gte=18
    if (paramName.indexOf('_gte') != -1) {
      paramName = paramName.replace('_gte', '');
      paramValue = '>' + paramValue;
    }
    if (paramName.indexOf('_lte') != -1) {
      paramName = paramName.replace('_lte', '');
      paramValue = '<' + paramValue;
    }

    if (paramName in apiSchema.schema) {
      if (apiSchema.schema[paramName] == String || ("type" in apiSchema.schema[paramName] && apiSchema.schema[paramName].type == String)) {
        if (paramValue.indexOf('==') === 0) {
          // e.g. title===Cat 
          // case sensitive equal match, better to set up index
          condition[paramName] = paramValue.replace('==', '');
        } else if (paramValue.substr(0, 1) == '%' && paramValue.substr(-1) == '%') {
          // e.g. title=%ca%
          // case insensitive full text match, will not use index, slow
          condition[paramName] = { $regex: new RegExp(paramValue.replace(/%/g, '')), $options: "i" };
        } else if (paramValue.indexOf('i=') === 0) {
          // e.g. title=i=cat
          // case insensitive equal match, may not use the index
          // https://docs.mongodb.com/manual/reference/operator/query/regex/
          condition[paramName] = { $regex: new RegExp("^" + paramValue.replace('i=', '').toLowerCase() + "$", "i") };
        } else {
          // e.g. title=cat, same as title===cat
          // case sensitive equal match, better to set up index
          condition[paramName] = paramValue.replace('==', '');
        }

      } else if (apiSchema.schema[paramName] == Number || ("type" in apiSchema.schema[paramName] && apiSchema.schema[paramName].type == Number)) {
        if (paramValue.indexOf('>') === 0) {
          // e.g. age=>18
          tempVar = Number(paramValue.replace('>', ''));
          if (!isNaN(tempVar)) {
            condition[paramName] = { $gte: tempVar };
          }
        } else if (paramValue.indexOf('<') === 0) {
          // e.g. age=<18
          tempVar = Number(paramValue.replace('<', ''));
          if (!isNaN(tempVar)) {
            condition[paramName] = { $lte: tempVar };
          }
        } else if (!isNaN(paramValue)) {
          // e.g. age=18
          condition[paramName] = { $eq: Number(paramValue) };
        }
      }
    }
    // console.log(paramName, paramValue)
  }

  // find multiple ids, e.g.  ?id=1&id=2&id=3 or ?id=1,2,3,4,5
  if (req.query.id || req.query._id) {
    const originId = req.query.id ? req.query.id : req.query._id;
    const idAry = (typeof originId == 'string') ? originId.split(',') : originId;
    let objIdAry = [];
    idAry.map(idStr => {
      if (db.mongoose.isValidObjectId(idStr)) {
        objIdAry.push(db.mongoose.Types.ObjectId(idStr));
      }
    })
    condition["_id"] = { "$in": objIdAry };
  }

  // full text search
  if (req.query.q && req.query.q.trim() != '') {
    return this.search(req, res);
  }

  // check if it's set only the owner can view the list
  const hasPermission = hasReadPermission(apiSchema, Universal, req.body, req, res);
  if (!hasPermission) {
    condition[API_CONFIG.FIELD_USER_ID] = req.currentUser.id;
  }

  // check if the schema hasPrivateConstraint
  if (hasPrivateConstraint(apiSchema, condition, req, res)) {
    condition[API_CONFIG.FIELD_PUBLIC] = true;
  }

  console.log('find query condition:', condition);

  // Add _sort and _order (ascending order by default)
  let defaultSort = {};
  if (req.query._sort && req.query._order) {
    if (req.query._sort in apiSchema.schema) {
      defaultSort[req.query._sort] = (req.query._order.toUpperCase() == 'DESC') ? -1 : 1;
    }
  }
  if (Object.keys(defaultSort).length === 0) {
    defaultSort = { _id: -1 };
  }

  // Add _start and _end or _limit 
  let defaultSkip = 0;
  let defaultLimit = 2000;
  if (req.query._start && req.query._end) {
    defaultSkip = parseInt(req.query._start);
    defaultLimit = req.query._limit ? parseInt(req.query._limit) : (parseInt(req.query._end) - parseInt(req.query._start));
  }


  let pipelineOperators = [
    {
      // '$match': { _id: db.mongoose.Types.ObjectId(id) }
      '$match': condition,
    },
    {
      '$sort': defaultSort,
    },
    {
      '$skip': defaultSkip,
    },
    {
      '$limit': defaultLimit,
    },
    // {
    //   "$addFields":
    //     { id: "$_id" }
    // }
  ];

  // To include children resources, add _embed
  if (req.query._embed) {
    await req.query._embed.split(',').map(async (tableName) => {
      const embedTable = tableName.split('|');
      const pluralTableName = embedTable[0];
      const foreignField = embedTable[1] ? embedTable[1] : null;

      const embedSchema = API_CONFIG.API_SCHEMAS.find(apiSchema => apiSchema.collectionName == pluralTableName);
      if (embedSchema) {
        const hasPermission = hasReadPermission(embedSchema, Universal, req.body, req, res);
        if (hasPermission) {
          const hasPrivate = hasPrivateConstraint(embedSchema, condition, req, res);

          console.log('tableName embedSchema hasPrivate', hasPrivate)
          pipelineOperators.push(getChildrenLookupOperator(null, pluralTableName, apiSchema, embedSchema, foreignField, hasPrivate));
        } else {
          console.log('No read permission for embedSchema ', embedSchema.apiRoute);
        }

      } else {
        console.log('tableName schema not defined', tableName)
      }
    })
    // console.log('pipelineOperators after req.query._embed', pipelineOperators);

  }

  // To include parent resource, add _expand
  if (req.query._expand) {
    await req.query._expand.split(',').map(async (tableName) => {
      const expandTable = tableName.split('|');
      const singularTableName = expandTable[0];
      const foreignField = expandTable[1] ? expandTable[1] : singularTableName + 'Id';
      const pluralTableName = getPluralName(singularTableName);
      const expandSchema = API_CONFIG.API_SCHEMAS.find(apiSchema => apiSchema.collectionName == pluralTableName);
      if (expandSchema) {
        const hasPermission = hasReadPermission(expandSchema, Universal, req.body, req, res);
        if (hasPermission) {
          console.log('tableName expandSchema', expandSchema.apiRoute)
          pipelineOperators.push(getParentLookupOperator(foreignField, singularTableName, pluralTableName, expandSchema));

          pipelineOperators.push({ $unwind: { path: "$" + singularTableName, "preserveNullAndEmptyArrays": true } });
        } else {
          console.log('No read permission for expandSchema ', expandSchema.apiRoute)
        }

      } else {
        console.log('tableName schema not defined', singularTableName, pluralTableName)
      }
    })
    // console.log('pipelineOperators after req.query._expand', pipelineOperators);
  }

  // test nested query, not working
  // pipelineOperators.push(
  //   { '$match': { "$pet.species": "Cat" } }
  // )

  // combine pre-defined pipeline from api.config.js
  if (apiSchema.aggregatePipeline) {
    pipelineOperators = [...pipelineOperators, ...apiSchema.aggregatePipeline]
  }

  // console.log('===exports.show pipelineOperators', pipelineOperators);

  const aggregateData = Universal.aggregate(pipelineOperators).exec((err, data) => {
    if (err) {
      return console.log('aggregate error', err)
    }
    // if (req.query?._responseType == 'returnData') {
    //   console.log('aggregate data', data)
    //   return data;
    // } else {
    // console.log('aggregate data.length', data.length)

    res.set("Access-Control-Expose-Headers", "X-Total-Count");
    res.set("x-total-count", data.length);
    res.send(data);
    // }

  });

  // console.log('aggregate aggregateQuery', aggregateData)
  return aggregateData;
};


const getTableId = (tableName) => {
  let tableId = tableName + 'Id';
  if (tableName.slice(-3) == 'ies') {
    tableId = tableName.slice(0, -3) + 'yId';
  } else if (tableName.slice(-2) == 'es') {
    tableId = tableName.slice(0, -2) + 'Id';
  } else if (tableName.slice(-1) == 's') {
    tableId = tableName.slice(0, -1) + 'Id';
  }
  return tableId;
}

const getPluralName = (tableName) => {
  let pluralName = tableName + 's';
  const lastLetter = tableName.slice(-1);
  const last2Letter = tableName.slice(-2);
  if (lastLetter == 's' || lastLetter == 'x' || lastLetter == 'z' || last2Letter == 'ch' || last2Letter == 'sh') {
    pluralName = tableName + 'es';
  } else if (lastLetter == 'y' && last2Letter != 'oy' && last2Letter != 'ey') {
    pluralName = tableName.slice(0, -1) + 'ies';
  } else if (lastLetter == 'f' && last2Letter != 'of' && last2Letter != 'ef') {
    pluralName = tableName.slice(0, -1) + 'ves';
  } else if (last2Letter == 'fe') {
    pluralName = tableName.slice(0, -2) + 'ves';
  }
  return pluralName;
}

const getChildrenLookupOperator = (id, tableName, apiSchema, embedSchema, foreignId, hasPrivate) => {
  const foreignField = foreignId ? foreignId : getTableId(apiSchema.collectionName);
  let pipeline = embedSchema.aggregatePipeline ? embedSchema.aggregatePipeline : [];
  let match = {};
  if (id) {
    // for show()
    match[foreignField] = id;
  } else {
    match['$expr'] = { "$eq": ["$" + foreignField, "$$strId"] };
  }

  if (hasPrivate) {
    match[API_CONFIG.FIELD_PUBLIC] = true;
  }

  pipeline = [{ '$match': match }, ...pipeline];
  const lookupOperator = {
    '$lookup': {
      'from': tableName,
      "let": { "strId": { $ifNull: ["$id", "id-is-null"] } }, // maybe $_id in some case
      // "let": { "strId": { $ifNull: ["$id", "$_id"] } },
      'as': tableName,
      'pipeline': pipeline
    }
  }
  //BUG: users table(users?id=5fdbf8dc098f0a77130d4123&_embed=pets,stories,comments|ownerId)  not working, but other tables works
  console.log('lookupOperator pipeline.match', match);
  return lookupOperator;
}

const getParentLookupOperator = (foreignField, singularTableName, pluralTableName, expandSchema) => {
  let pipeline = expandSchema.aggregatePipeline ? expandSchema.aggregatePipeline : [];
  let match = {};
  // match['_id'] = db.mongoose.Types.ObjectId(id);
  // match['$expr'] = { "$eq": ["$_id", "$$userId"] };
  // match['$expr'] = { "$eq": ["$email", "Aaron@test.com"] };
  // match['$expr'] = { "$eq": ["$_id", "5f9e18f0d9886400089675eb"] };
  // match['$expr'] = { "$eq": ["$_id", db.mongoose.Types.ObjectId("5f9e18f0d9886400089675eb")] };
  match['$expr'] = { "$eq": ["$_id", "$objId"] };

  pipeline = [
    ...[
      {
        $addFields: {
          objId: {
            $convert: {
              input: "$$strId",
              to: "objectId",
              onError: 0
            }
            // "$toObjectId": "$$strId"
          }
        }
      },
      { '$match': match }
    ],
    ...pipeline
  ];
  const lookupOperator = {
    '$lookup': {
      'from': pluralTableName,
      "let": { "strId": "$" + foreignField },
      'as': singularTableName,
      'pipeline': pipeline
    }
  }
  // console.log('getParentLookupOperator pipeline', pipeline);
  return lookupOperator;
}

// Find a single Universal with an id via findById
exports.showByFind = async (req, res) => {
  const apiSchema = getApiSchema(req, res);

  // console.log(apiSchema, req.params);
  const id = req.params[apiSchema.apiRoute];

  const Universal = getUniversalDb(req, res);
  let query = Universal.findById(id);

  // only display specific fields or exclude some schema fields
  if (apiSchema.selectFields && apiSchema.selectFields.length > 0) {
    // query.select(apiSchema.selectFields);
  }

  query.then((data) => {
    if (!data)
      res.status(404).send({ message: "Not found the item with id " + id });
    else {
      res.send(data);
    };
  }).catch((err) => {
    res.status(500).send({ message: "Error retrieving the item with id=" + id });
  });
};


// Find a single Universal with an id via aggregate
// To include children resources, add _embed
// To include parent resource, add _expand
// e.g. /pets/5fcd8f4a3b755f0008556057?_expand=user,file|mainImageId&_embed=pets,stories
exports.show = async (req, res) => {
  const apiSchema = getApiSchema(req, res);

  // console.log(apiSchema, req.params);
  const id = req.params[apiSchema.apiRoute];
  if (!db.mongoose.isValidObjectId(id)) {
    res.status(500).send({ message: id + " is not a ValidObjectId " });
    return false;
  }

  const Universal = getUniversalDb(req, res);

  // check if it's set only the owner can view the list
  const existItem = await Universal.findById(id);
  const hasPermission = hasReadPermission(apiSchema, Universal, existItem, req, res);
  if (!hasPermission) {
    res.status(401).send({ message: " No read permission for " + req.currentUser.id });
    return false;
  }

  // check if the schema hasPrivateConstraint
  if (hasPrivateConstraint(apiSchema, existItem, req, res)) {
    res.status(401).send({ message: " This item is private" });
    return false;
  }

  let pipelineOperators = [
    {
      '$match': { _id: db.mongoose.Types.ObjectId(id) }
    }
  ];

  // To include children resources, add _embed
  if (req.query._embed) {
    await req.query._embed.split(',').map(async (tableName) => {
      const embedTable = tableName.split('|');
      const pluralTableName = embedTable[0];
      const foreignField = embedTable[1] ? embedTable[1] : null;

      const embedSchema = API_CONFIG.API_SCHEMAS.find(apiSchema => apiSchema.collectionName == pluralTableName);;
      if (embedSchema) {
        // check embedSchema permission as well
        const hasPermission = hasReadPermission(embedSchema, Universal, existItem, req, res);
        if (hasPermission) {
          let hasPrivate = hasPrivateConstraint(embedSchema, existItem, req, res);

          if (hasPrivate && apiSchema.apiRoute == API_CONFIG.USER_ROUTE && req.currentUser && existItem.id == req.currentUser.id) {
            // if is user table
            hasPrivate = false;
          }
          console.log('tableName embedSchema hasPrivate', hasPrivate); pipelineOperators.push(getChildrenLookupOperator(id, pluralTableName, apiSchema, embedSchema, foreignField, hasPrivate));
        } else {
          // ignore the embed schema
          console.log('No read permission for embed schema ' + embedSchema.apiRoute + '');
        }
      } else {
        console.log('tableName schema not defined', tableName)
      }

    })
  }

  // To include parent resource, add _expand
  if (req.query._expand) {
    await req.query._expand.split(',').map(async tableName => {
      const expandTable = tableName.split('|');
      const singularTableName = expandTable[0];
      const foreignField = expandTable[1] ? expandTable[1] : singularTableName + 'Id';
      const pluralTableName = getPluralName(singularTableName);
      const expandSchema = API_CONFIG.API_SCHEMAS.find(apiSchema => apiSchema.collectionName == pluralTableName);
      if (expandSchema) {
        // check embedSchema permission as well
        const hasPermission = hasReadPermission(expandSchema, Universal, existItem, req, res);
        if (hasPermission) {
          // console.log('tableName expandSchema', expandSchema)
          pipelineOperators.push(getParentLookupOperator(foreignField, singularTableName, pluralTableName, expandSchema));

          pipelineOperators.push({ $unwind: { path: "$" + singularTableName, "preserveNullAndEmptyArrays": true } });
        } else {
          // ignore the expand schema
          console.log('No read permission for expand schema ' + expandSchema.apiRoute + '');
        }

      } else {
        console.log('tableName schema not defined', singularTableName, pluralTableName)
      }

    })
  }
  if (apiSchema.aggregatePipeline) {
    pipelineOperators = [...pipelineOperators, ...apiSchema.aggregatePipeline]
  }


  // console.log('===exports.show pipelineOperators', pipelineOperators, apiSchema);

  let query = await Universal.aggregate(pipelineOperators).exec((err, data) => {
    if (err) {
      return console.log('aggregate error', err)
    }
    // console.log('aggregate data', data)
    if (!data || data.length == 0)
      res.status(404).send({ message: "Not found the item with id " + id });
    else {
      res.send(data[0]);
    };
  });

  // console.log(query)
  return query;
};

const hasWritePermission = async (apiSchema, Universal, id, req, res) => {
  if (!API_CONFIG.ENABLE_AUTH) {
    return true;
  }
  if (!req.currentUser) {
    return false;
  }
  if (req.currentUser.role && req.currentUser.role.toLowerCase().indexOf('admin') != -1) {
    // currentUser is admin
    console.log('=====currentUser is admin', req.currentUser.firstName);
    return true;
  } else {
    // check if must be admin
    if (apiSchema.writeRules && apiSchema.writeRules.checkAdmin) {
      return false;
    }
    // normal user, must be owner itself
    const existItem = id ? await Universal.findById(id) : req.body;
    if (!id) {
      console.log('======no id, add new item, check auth:', req.currentUser.id, existItem[API_CONFIG.FIELD_USER_ID]);
      // if no id, refactor the formData(req.body) with req.currentUser.id
      existItem[API_CONFIG.FIELD_USER_ID] = req.currentUser.id;
    }
    if (!existItem) {
      console.log(`Item not exists`);
      return false;
    }

    // if is update, check if all req.body fields are selfUpdateFields
    if (id && apiSchema.writeRules && apiSchema.writeRules.selfUpdateFields && apiSchema.writeRules.selfUpdateFields.length > 0) {
      let checkPoint = null; // not selfUpdateFields
      let noOtherFields = true;
      const fields = apiSchema.writeRules.selfUpdateFields;

      for (const [pName, pValue] of Object.entries(req.body)) {
        if (fields.includes(pName)) {
          if (!existItem[pName]) {
            if (parseInt(pValue) != 1 && parseInt(pValue) != 0) {
              checkPoint = false;
              console.log('------selfUpdateFields checkPoint1', checkPoint)
              return false;
            } else {
              checkPoint = true;
            }
          } else if (Math.abs(parseInt(existItem[pName]) - parseInt(pValue)) > 1) {
            checkPoint = false;
            console.log('------selfUpdateFields checkPoint2', checkPoint)
            return false;
          } else {
            checkPoint = true;
          }
        } else {
          noOtherFields = false;
        }
      }
      console.log('------selfUpdateFields checkPoint3', checkPoint)
      if (noOtherFields && checkPoint) {
        return true; // pass all check points and noOtherFields
      } else if (checkPoint === false) {
        // only === false means has invalid selfUpdateFields, NOT ===null
        // even owner itself can not change selfUpdateFields with step>1
        return false;
      }
    }

    // hasOwnProperty return false if userId not defined in api.config.js
    if ((apiSchema.schema.hasOwnProperty(API_CONFIG.FIELD_USER_ID) || existItem[API_CONFIG.FIELD_USER_ID]) && req.currentUser.id != existItem[API_CONFIG.FIELD_USER_ID]) {
      console.log("It not your item, CAN NOT UPDATE ITEM WITH ID " + (id || existItem[API_CONFIG.FIELD_USER_ID]));
      return false;
    }
    console.log('=====currentUser id', req.currentUser.id, existItem[API_CONFIG.FIELD_USER_ID], apiSchema.schema.hasOwnProperty(API_CONFIG.FIELD_USER_ID), existItem);

    return true;
  }

}

const hasReadPermission = (apiSchema, Universal, existItem, req, res) => {
  let hasPermission = false;
  if (apiSchema.readRules && apiSchema.readRules.checkAuth && apiSchema.readRules.checkOwner) {
    if (!req.currentUser) {
      console.log('=====hasReadPermission, NO req.currentUser for', apiSchema.apiRoute);
      return false;
    }
    if (req.currentUser.role && req.currentUser.role.toLowerCase().indexOf('admin') != -1) {
      // currentUser is admin
      console.log('=====hasReadPermission, currentUser is admin', req.currentUser.firstName);
      hasPermission = true;
    } else {
      // normal user, must be owner itself
      if (apiSchema.schema.hasOwnProperty(API_CONFIG.FIELD_USER_ID)) {
        // const existItem = itemData === null ? req.body : itemData;
        if (existItem && existItem[API_CONFIG.FIELD_USER_ID] && req.currentUser.id == existItem[API_CONFIG.FIELD_USER_ID]) {
          console.log('=====hasReadPermission, passed, currentUser is the owner');
          hasPermission = true;
        }
        if (!existItem) {
          console.log('=====hasReadPermission, item not find ');
        }
      } else {
        // property not defined in schema(api.config.js)
        hasPermission = false;
      }

    }
  } else {
    console.log('=====hasReadPermission,passed, no need to check owner for ', apiSchema.apiRoute);
    hasPermission = true;
  }
  return hasPermission;
}

const hasPrivateConstraint = (apiSchema, existItem, req, res) => {
  // check if the schema has isPublic field
  let hasPrivateConstraint = false;
  if (apiSchema.schema.hasOwnProperty(API_CONFIG.FIELD_PUBLIC)) {
    if (!req.currentUser) {
      console.log('hasPrivateConstraint: no req.currentUser');
      hasPrivateConstraint = true;
    } else {
      if (req.currentUser.role && req.currentUser.role.toLowerCase().indexOf('admin') != -1) {
        // is admin
      } else if (existItem[API_CONFIG.FIELD_USER_ID] && existItem[API_CONFIG.FIELD_USER_ID] == req.currentUser.id) {
        // is owner
      } else if (existItem[API_CONFIG.FIELD_TARGET_USER_ID] && existItem[API_CONFIG.FIELD_TARGET_USER_ID] == req.currentUser.id) {
        // is target user, e.g. the user who receive a comment/message/reply
      } else {
        hasPrivateConstraint = true;
      }
    }
  }
  return hasPrivateConstraint;
};

// Update a Universal by the id in the request
exports.update = async (req, res) => {
  if (!req.body) {
    return res.status(400).send({
      message: "Data to update can not be empty!",
    });
  }
  const apiSchema = getApiSchema(req, res);
  console.log('====update req', req.currentUser, req.body);
  const id = req.params[apiSchema.apiRoute];
  const Universal = getUniversalDb(req, res);

  const hasPermission = await hasWritePermission(apiSchema, Universal, id, req, res);
  if (!hasPermission) {
    res.status(401).send({
      message: `No permission to update item with id=${id}. currentUser: ${req.currentUser.id}`,
    });
    return false;
  }
  // console.log('update req.body', req.body)

  // TODO: if id not exist, create a new item -- for PUT method
  Universal.findByIdAndUpdate(id, req.body, {
    useFindAndModify: false,
    upsert: true,
    new: true, // return new data instead old data
  })
    .then((data) => {
      if (!data) {
        res.status(404).send({
          message: `Cannot find the item with id=${id}. Try to Create a new one!!`,
        });
        // console.log("the item was not found! Create a new one!");
        // create(req, res);
      } else {
        // res.send({
        //   message: "Item was updated successfully.",
        //   data: data,
        //   total: 1
        // });
        res.send(data);
      }
    })
    .catch((err) => {
      res.status(500).send({
        message: "Error updating the item with id=" + id,
      });
    });
};




// Delete a Universal with the specified id in the request
exports.destroy = async (req, res) => {
  const apiSchema = getApiSchema(req, res);
  // console.log(apiSchema, req.params);
  const id = req.params[apiSchema.apiRoute];
  const Universal = getUniversalDb(req, res);

  const hasPermission = await hasWritePermission(apiSchema, Universal, id, req, res);
  if (!hasPermission) {
    res.status(404).send({
      message: `No permission to DELETE item with id=${id}. currentUser: ${req.currentUser.id}`,
    });
    return false;
  }

  Universal.findByIdAndRemove(id)
    .then((data) => {
      if (!data) {
        res.status(404).send({
          message: `Cannot delete the item with id=${id}. Maybe the item was not found!`,
        });
      } else {
        res.send({
          message: "The item was deleted successfully!",
        });
      }
    })
    .catch((err) => {
      res.status(500).send({
        message: "Could not delete the item with id=" + id,
      });
    });
};


// full text search
exports.search = (req, res) => {
  const keyword = req.params.keyword ? req.params.keyword : req.query.q;
  const Universal = getUniversalDb(req, res);
  //   Universal.find({ $text: { $search: keyword } })
  const apiSchema = getApiSchema(req, res);
  // console.log('apiSchema=', apiSchema);
  Universal.aggregate([
    {
      $search: {
        text: {
          query: keyword.trim(),
          path: apiSchema.searchFields,
        },
      },
    },
  ])
    .then((data) => {
      res.send(data);
    })
    .catch((err) => {
      res.status(500).send({
        message:
          err.message || "Some error occurred while searching. ",
      });
    });
};

// user token, todo: security
exports.getUserToken = async (req, res) => {

  if (!req.body.firebaseIdToken && !req.body.awsIdToken) {
    console.log('getUserToken req.body', req.body, req.body)
    return res.status(400).json({ error: "Missing params for getUserToken" });
  }

  let findCondition = {};

  if (req.body.firebaseIdToken) {

    const decodedToken = await decodeFirebaseIdToken(req.body.firebaseIdToken);
    console.log('decodedToken decodedToken ', decodedToken);
    if (!decodedToken) {
      return res.status(401).json({ error: "Wrong firebaseIdToken" });
    }
    if (!decodedToken.uid || decodedToken.uid != req.body.firebaseUid) {
      return res.status(401).json({ error: "firebaseUid not match firebaseIdToken" });
    }
    findCondition.firebaseUid = decodedToken.uid;
  }

  const Universal = getUniversalDb(req, res);

  // if (!req.body.email) {
  //   return res.status(400).json({ error: "no email" });
  // }
  req.body._responseType = 'returnData';
  // return this.index(req, res);
  // const returnData = this.index(req, res);



  const userData = await Universal.findOne(findCondition).exec();
  console.log('_responseType userData', userData);
  if (!userData) {
    console.log('No such user findCondition', findCondition);
    return res.status(401).json({ error: "No such user" });
  }

  let userProfile = {
    id: userData._id ? userData._id : userData.id,
    email: userData.email,
    firstName: userData.firstName,
    lastName: userData.lastName,
    role: userData.role,
  };
  console.log('_responseType userProfile', userData['firstName']);
  // create token
  userProfile.accessToken = jwt.sign(
    userProfile,// payload data
    API_CONFIG.JWT_SECRET
  );


  res.send(userProfile);
  // res.set("x-total-count", data.length);
  // res.send(data);
}


const decodeFirebaseIdToken = async (firebaseIdToken) => {
  const firebaseAdmin = require("firebase-admin");
  if (!firebaseIdToken || firebaseIdToken.length < 250 || !API_CONFIG.FIREBASE_DB_URL || !API_CONFIG.FIREBASE_SDK_KEY || !API_CONFIG.FIREBASE_SDK_KEY.hasOwnProperty('private_key')) {
    return false;
  }
  // !admin.apps.length ? admin.initializeApp() : admin.app();
  if (firebaseAdmin.apps.length == 0) {
    firebaseAdmin.initializeApp({
      credential: firebaseAdmin.credential.cert(API_CONFIG.FIREBASE_SDK_KEY),
      databaseURL: API_CONFIG.FIREBASE_DB_URL
    });
  } else {
    firebaseAdmin.app();
  }

  try {
    const decodedToken = await firebaseAdmin
      .auth()
      .verifyIdToken(firebaseIdToken);
    // .then((decodedToken) => {
    //   const uid = decodedToken.uid;
    //   console.log('firebaseIdToken decodedToken1 = ', decodedToken);
    //   return false;
    // })
    // .catch((error) => {
    //   // Handle error
    //   console.log('firebaseIdToken decodedToken error = ', error);
    // });

    // console.log('firebaseIdToken decodedToken2 = ', decodedToken);
    return decodedToken;
  } catch (err) {
    console.log('decodedToken error = ', err.message);
    return false;
  }

}