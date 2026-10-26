    // La paginación solo distribuye contenido visual: nunca calcula valores de negocio.
    addEventListener('load',async()=>{
      await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));
      const destino=document.getElementById('documento');let pagina,contenido,cuerpo;
      /** Crea una hoja con marca, pie y área útil medida antes de distribuir filas. */
      function nueva(tabla=true){pagina=document.createElement('section');pagina.className='pagina'+(destino.children.length?' continuacion':'');pagina.innerHTML=document.getElementById('cabecera').innerHTML+'<div class="contenido"></div><footer><span>MATISTA · '+/* MATISTA_TITULO */null+'</span><span class="numeracion"></span></footer>';destino.append(pagina);contenido=pagina.querySelector('.contenido');contenido.style.height=(pagina.querySelector('footer').offsetTop-contenido.offsetTop-14)+'px';contenido.style.maxHeight='none';if(tabla){contenido.append(document.getElementById('tabla').content.cloneNode(true));cuerpo=contenido.querySelector('tbody');}}
      /** Comprueba si el bloque ocupa más altura que el área imprimible disponible. */
      function excede(){return contenido.scrollHeight>contenido.clientHeight+1;}
      nueva();
      for(const fila of document.getElementById('filas').content.querySelectorAll('tr')){const clon=fila.cloneNode(true);cuerpo.append(clon);if(excede()&&cuerpo.children.length>1){clon.remove();nueva();cuerpo.append(clon);}}
      const notas=document.getElementById('notas').content.querySelector('section');
      if(notas){const titulo=notas.querySelector('h3');contenido.append(titulo.cloneNode(true));for(const parrafo of notas.querySelectorAll('p')){const clon=parrafo.cloneNode(true);contenido.append(clon);if(excede()){clon.remove();if(contenido.lastElementChild.tagName==='H3')contenido.lastElementChild.remove();nueva(false);contenido.append(titulo.cloneNode(true),clon);}}}
      const paginas=[...destino.children];paginas.forEach((p,i)=>p.querySelector('.numeracion').textContent=(i+1)+' / '+paginas.length);
      await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));if([...document.querySelectorAll('.contenido')].some(c=>c.scrollHeight>c.clientHeight+1))document.documentElement.dataset.documentoError='desbordamiento';document.documentElement.dataset.documentoListo='true';/* MATISTA_IMPRIMIR */
    });
