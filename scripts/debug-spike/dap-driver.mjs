export function initializeArgs() {
  return {
    adapterID: 'pwa-node',
    clientID: 'continuo-debug-spike',
    clientName: 'Continuo debug spike',
    columnsStartAt1: true,
    linesStartAt1: true,
    pathFormat: 'path',
    supportsVariableType: true,
    supportsVariablePaging: true,
  };
}

export async function runClosedLoop(
  parentClient,
  { program, breakpointFile, breakpointLine, cwd = process.cwd(), stopForTeardown = false },
) {
  const processEvents = [];
  const outputEvents = [];
  let childClient = null;
  let resolveChildReady;
  let rejectChildReady;
  const childReady = new Promise((resolve, reject) => {
    resolveChildReady = resolve;
    rejectChildReady = reject;
  });

  const recordProcess = (event) => processEvents.push(event.body ?? {});
  const recordOutput = (event) => outputEvents.push(event.body ?? {});
  parentClient.on('process', recordProcess);
  parentClient.on('output', recordOutput);

  parentClient.setStartDebuggingHandler(async (request) => {
    childClient = parentClient.createChildSession();
    childClient.on('process', recordProcess);
    childClient.on('output', recordOutput);
    await childClient.connectToServer();

    const childInitialized = childClient.waitForEvent('initialized', 20_000);
    await childClient.sendRequest('initialize', initializeArgs());
    await childInitialized;
    await childClient.sendRequest('setBreakpoints', {
      source: { path: breakpointFile },
      breakpoints: [{ line: breakpointLine }],
      sourceModified: false,
    });
    await childClient.sendRequest('configurationDone');

    const requestCommand = request.arguments?.request ?? 'launch';
    const configuration = request.arguments?.configuration;
    if (!configuration) {
      throw new Error('startDebugging request missing configuration');
    }
    childClient.sendRequestNoWait(requestCommand, {
      ...configuration,
      cwd,
      sourceMaps: true,
      pauseForSourceMap: true,
      outFiles: [`${cwd}/.out/**/*.js`],
      resolveSourceMapLocations: [`${cwd}/.out/**/*.js`, '!**/node_modules/**'],
    });
    resolveChildReady(childClient);
    return {};
  });

  const initialized = parentClient.waitForEvent('initialized', 20_000);
  await parentClient.sendRequest('initialize', initializeArgs());
  await initialized;
  await parentClient.sendRequest('setBreakpoints', {
    source: { path: breakpointFile },
    breakpoints: [{ line: breakpointLine }],
    sourceModified: false,
  });
  await parentClient.sendRequest('configurationDone');

  parentClient.sendRequestNoWait('launch', {
    type: 'pwa-node',
    request: 'launch',
    name: 'Continuo debug spike fixture',
    program,
    cwd,
    console: 'internalConsole',
    outputCapture: 'std',
    sourceMaps: true,
    pauseForSourceMap: true,
    autoAttachChildProcesses: false,
    outFiles: [`${cwd}/.out/**/*.js`],
    resolveSourceMapLocations: [`${cwd}/.out/**/*.js`, '!**/node_modules/**'],
  });

  const debugClient = await Promise.race([
    childReady,
    parentClient.waitForEvent('terminated', 30_000).then(() => {
      throw new Error('parent session terminated before child debug session stopped');
    }),
  ]).catch((err) => {
    rejectChildReady(err);
    throw err;
  });

  const stopped = await debugClient.waitForEvent('stopped', 30_000);
  const threadId = stopped.body?.threadId ?? 1;
  const stack = await debugClient.sendRequest('stackTrace', {
    threadId,
    startFrame: 0,
    levels: 1,
  });
  const frame = stack.body.stackFrames[0];
  const scopes = await debugClient.sendRequest('scopes', { frameId: frame.id });
  const variables = await collectVariables(debugClient, scopes.body.scopes);
  const evaluate = {
    nestedAnswer: await evaluateExpression(debugClient, frame.id, 'nested.answer'),
    innerK: await evaluateExpression(debugClient, frame.id, 'nested.inner.k'),
    arrayLength: await evaluateExpression(debugClient, frame.id, 'arr.length'),
    sum: await evaluateExpression(debugClient, frame.id, 'sum'),
  };

  assertVariableSnapshot({ stopped, frame, breakpointFile, breakpointLine, variables, evaluate });

  if (stopForTeardown) {
    return {
      debugClient,
      stopped,
      threadId,
      frame,
      variables,
      evaluate,
      processEvents,
      outputEvents,
    };
  }

  const staleVariablesReference = variables.nested?.variablesReference;
  await debugClient.sendRequest('continue', { threadId });
  let staleReferenceRejected = true;
  if (staleVariablesReference) {
    try {
      await debugClient.sendRequest('variables', {
        variablesReference: staleVariablesReference,
      }, 2_000);
      staleReferenceRejected = false;
    } catch {
      staleReferenceRejected = true;
    }
  }

  await debugClient.sendRequest('disconnect', {
    terminateDebuggee: true,
    restart: false,
  }).catch(() => undefined);

  return {
    debugClient,
    stopped,
    threadId,
    frame,
    variables,
    evaluate,
    processEvents,
    outputEvents,
    staleReferenceRejected,
  };
}

async function evaluateExpression(client, frameId, expression) {
  const response = await client.sendRequest('evaluate', {
    expression,
    frameId,
    context: 'watch',
  });
  return response.body.result;
}

async function collectVariables(client, scopes) {
  const snapshot = {};
  for (const scope of scopes) {
    if (scope.expensive || scope.name === 'Global') {
      continue;
    }
    const response = await client.sendRequest('variables', {
      variablesReference: scope.variablesReference,
    });
    for (const variable of response.body.variables) {
      if (variable.name === 'nested') {
        snapshot.nested = await collectObjectVariable(client, variable);
      }
      if (variable.name === 'arr') {
        snapshot.arr = await collectArrayVariable(client, variable);
      }
      if (variable.name === 'sum') {
        snapshot.sum = variable.value;
      }
    }
  }
  return snapshot;
}

async function collectObjectVariable(client, variable) {
  const result = {
    value: variable.value,
    variablesReference: variable.variablesReference,
    children: {},
  };
  if (!variable.variablesReference) return result;
  const response = await client.sendRequest('variables', {
    variablesReference: variable.variablesReference,
  });
  for (const child of response.body.variables) {
    result.children[child.name] = {
      value: child.value,
      variablesReference: child.variablesReference,
    };
    if (child.name === 'inner' && child.variablesReference) {
      result.children.inner.children = {};
      const inner = await client.sendRequest('variables', {
        variablesReference: child.variablesReference,
      });
      for (const innerChild of inner.body.variables) {
        result.children.inner.children[innerChild.name] = {
          value: innerChild.value,
          variablesReference: innerChild.variablesReference,
        };
      }
    }
  }
  return result;
}

async function collectArrayVariable(client, variable) {
  const result = {
    value: variable.value,
    variablesReference: variable.variablesReference,
    items: {},
  };
  if (!variable.variablesReference) return result;
  const response = await client.sendRequest('variables', {
    variablesReference: variable.variablesReference,
  });
  for (const child of response.body.variables) {
    result.items[child.name] = child.value;
  }
  return result;
}

function assertVariableSnapshot({
  stopped,
  frame,
  breakpointFile,
  breakpointLine,
  variables,
  evaluate,
}) {
  if (stopped.body?.reason !== 'breakpoint') {
    throw new Error(`expected breakpoint stop, got ${stopped.body?.reason}`);
  }
  if (frame.source?.path !== breakpointFile || frame.line !== breakpointLine) {
    throw new Error(
      `expected ${breakpointFile}:${breakpointLine}, got ${frame.source?.path}:${frame.line}`,
    );
  }
  if (variables.nested?.children.answer?.value !== '42') {
    throw new Error('nested.answer variable mismatch');
  }
  if (!["'v'", '"v"'].includes(variables.nested?.children.inner?.children.k?.value)) {
    throw new Error('nested.inner.k variable mismatch');
  }
  if (variables.arr?.items['0'] !== '1' || variables.arr?.items['2'] !== '3') {
    throw new Error('arr variable mismatch');
  }
  if (variables.sum !== '21') {
    throw new Error(`sum variable mismatch: ${variables.sum}`);
  }
  if (
    evaluate.nestedAnswer !== '42' ||
    !["'v'", '"v"'].includes(evaluate.innerK) ||
    evaluate.arrayLength !== '3' ||
    evaluate.sum !== '21'
  ) {
    throw new Error(`evaluate mismatch: ${JSON.stringify(evaluate)}`);
  }
}
